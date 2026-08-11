/**
 * Launch a deployment run.
 *
 * Mirrors the generation launcher and differs in the ways that matter: a narrower
 * token (`sandbox_deploy`), a different template, and the marketing tool's credentials
 * on the sandbox environment rather than in the hydration file — because the hydration
 * file is saved beside the run for audit and anything in it is readable forever.
 *
 *   npx tsx scripts/launch-deploy.ts --deployment <id>
 */
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { Sandbox } from 'e2b'
import { primaryTextFrom, resolveDeployStatus } from '../src/deploy-fields'
import { buildDeploymentHydration, RUN_BUDGET_SECONDS } from '../src/hydration'
import { decodePayload, mintRunToken } from '../src/rls'
import { readEnvFile } from '../src/openai-image'
import { checkStamp } from '../../sandbox/check-stamp'

const ROOT = join(import.meta.dirname, '..', '..')
const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env }

for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'E2B_API_KEY', 'OPENAI_API_KEY']) {
  if (!env[key]) throw new Error(`${key} missing from .env`)
}
const SUPABASE_URL = env.SUPABASE_URL as string
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY as string
const PROJECT_REF = decodePayload(env.SUPABASE_ANON_KEY as string).ref as string

// The deployment image only — see the note in launch-run.ts.
const stamp = checkStamp('deployment')
if (!stamp.fresh && !process.argv.includes('--allow-stale')) {
  console.error(`refusing to launch — ${stamp.reason}`)
  for (const c of stamp.changed) console.error(`  changed: ${c}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = args.indexOf('--deployment')
const deploymentId = flag !== -1 ? args[flag + 1] : null
if (!deploymentId) throw new Error('usage: launch-deploy.ts --deployment <id>')

const headers = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` }
async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 240)}`)
  return (text ? JSON.parse(text) : null) as T
}

const [deployment] = await rest<
  {
    id: string
    kit_id: string
    name: string
    target_tool: string
    target_url: string
    status: string
    target_campaign: string | null
    target_objective: string | null
    target_notes: string | null
    target_fields: Record<string, string> | null
  }[]
>(
  `deployments?id=eq.${deploymentId}&select=id,kit_id,name,target_tool,target_url,status,target_campaign,target_objective,target_notes,target_fields`,
)
if (!deployment) throw new Error(`no deployment ${deploymentId}`)

const items = await rest<{ revision_id: string; canvas_name: string | null }[]>(
  `deployment_items?deployment_id=eq.${deploymentId}&select=revision_id,canvas_name`,
)
if (items.length === 0) throw new Error('this deployment has no items')

// Only approved revisions ship. Checked here as well as by policy, because this is the
// privileged path and an unapproved ad reaching a live tool is unrecoverable.
const revisionIds = [...new Set(items.map((i) => i.revision_id))]
const revisions = await rest<{ id: string; n: number; request_id: string; approved_at: string | null }[]>(
  `revisions?id=in.(${revisionIds.join(',')})&select=id,n,request_id,approved_at`,
)
const unapproved = revisions.filter((r) => !r.approved_at)
if (unapproved.length) throw new Error(`refusing: ${unapproved.length} revision(s) are not approved`)

/**
 * One revision per deployment.
 *
 * `revisions[0]` used to be taken off an unordered `in.()` result, so a deployment
 * spanning two revisions shipped whichever the database happened to return first and
 * said nothing at all about the other. A run is scoped to one revision the whole way
 * down — the run row, the token claims, the storage prefix and every RLS policy — so
 * this is a refusal rather than a loop.
 */
if (revisions.length > 1) {
  throw new Error(
    `refusing: this deployment spans ${revisions.length} revisions ` +
      `(${revisions.map((r) => r.n).join(', ')}), and a run is scoped to one. ` +
      'Create one deployment per revision.',
  )
}

const revision = revisions[0]
const [request] = await rest<{ id: string; campaign_name: string; copy: Record<string, string | null> }[]>(
  `requests?id=eq.${revision.request_id}&select=id,campaign_name,copy`,
)

// `bytes` is selected because the box checks each download against it, and because an
// artifact over the tool's upload ceiling is refusable before a box exists.
const artifacts = await rest<
  { id: string; relative_path: string; storage_key: string; canvas_name: string | null; bytes: number | null }[]
>(
  `artifacts?revision_id=eq.${revision.id}&role=eq.render&select=id,relative_path,storage_key,canvas_name,bytes&order=canvas_name.asc`,
)
const canvases = await rest<{ name: string; width: number; height: number }[]>(
  `request_canvases?request_id=eq.${revision.request_id}&select=name,width,height`,
)

/**
 * Which canvases ship.
 *
 * A null `canvas_name` on the item means every canvas on the revision — the default,
 * and the common case, because a campaign's sizes are all meant to go live. A *named*
 * canvas with no render behind it used to be filtered away in silence, so a deployment
 * asking for three sizes could ship two and still read as complete.
 */
const namedCanvases = [...new Set(items.map((i) => i.canvas_name).filter((n): n is string => Boolean(n)))]
const wanted = namedCanvases.length
  ? artifacts.filter((a) => a.canvas_name && namedCanvases.includes(a.canvas_name))
  : artifacts

/** Signed with the same budget as the sandbox timeout, so nothing expires mid-run. */
async function sign(key: string) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/work/${key}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: RUN_BUDGET_SECONDS }),
  })
  if (!response.ok) throw new Error(`could not sign ${key}`)
  const { signedURL } = (await response.json()) as { signedURL: string }
  return `${SUPABASE_URL}/storage/v1${signedURL}`
}

/**
 * Everything that must be true before a box exists, gathered in one place.
 *
 * The agent stops when the tool asks for something nothing supplies — correct, and it
 * costs a sandbox, two minutes and a recording of a form being abandoned. All of this
 * is knowable from rows we already hold, so it is knowable now, and the refusal is
 * recorded against the deployment rather than only printed: the person who needs it is
 * looking at the Deploy screen, not at a launcher log they cannot reach.
 *
 * Nothing below this point may run before the list is empty. It used to sit *after* the
 * run and deploy_run inserts, so every refusal left a pair of orphan `starting` rows
 * behind for a run that never happened.
 */
const blockers: string[] = []

for (const name of namedCanvases) {
  if (!artifacts.some((a) => a.canvas_name === name)) {
    blockers.push(
      `Canvas "${name}" — the deployment asks for it, and revision ${revision.n} has no render of it`,
    )
  }
}
if (wanted.length === 0) blockers.push('Renders — this revision has none to publish')

/**
 * The tool's own upload ceiling, mirrored from `web/lib/adstream-options.ts`.
 *
 * One number, checked here because the cheapest moment to refuse an oversized creative
 * is before a box exists rather than at a form that greys out its own Publish button.
 * Deliberately not imported across the package boundary for a single constant: if it
 * drifts the cost is a warning that is slightly wrong, never a deploy that is.
 */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
for (const artifact of wanted) {
  const bytes = artifact.bytes ?? 0
  if (bytes > MAX_UPLOAD_BYTES) {
    blockers.push(
      `Canvas "${artifact.canvas_name}" — ${bytes}B is over the tool's ${MAX_UPLOAD_BYTES}B upload ceiling`,
    )
  }
}

/**
 * The values the form will ask for, with the two we can derive filled in.
 *
 * Derived rather than required, because both come from work this customer has already
 * approved: the ad's body text is their copy, and its name is their campaign. The rest
 * are Adstream's own taxonomy — a campaign, an audience, a placement — which nothing on
 * our side can know, so those stay required and are chosen from the tool's option sets.
 */
const fields: Record<string, string> = { ...(deployment.target_fields ?? {}) }
function derive(key: string, value: string) {
  if (typeof fields[key] !== 'string' || !fields[key].trim()) fields[key] = value
}
derive('Primary text', primaryTextFrom(request.copy ?? {}))
derive('Ad name', (deployment.name || request.campaign_name || '').trim())

const REQUIRED_TOOL_FIELDS = [
  'Ad name',
  'Primary text',
  'Audience',
  'Placements',
  'Daily budget',
  'Call to action',
]

if (!deployment.target_campaign?.trim()) blockers.push('Campaign — pick one on the Deploy screen')
if (!deployment.target_objective?.trim()) blockers.push('Objective — pick one on the Deploy screen')
for (const field of REQUIRED_TOOL_FIELDS) {
  const value = fields[field]
  if (typeof value !== 'string' || !value.trim()) {
    blockers.push(`${field} — set it in the deployment's tool fields`)
  }
}

if (blockers.length) {
  await rest(`deployments?id=eq.${deploymentId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'stopped',
      verified_note:
        `not started — ${blockers.length} blocker(s): ` +
        blockers.map((b) => b.split(' — ')[0]).join(', '),
    }),
  }).catch(() => {})

  console.error(`\nrefusing to deploy — ${blockers.length} blocker(s):`)
  for (const item of blockers) console.error(`  · ${item}`)
  console.error('\nNo sandbox was started. Fix these and run the deploy again.\n')
  process.exit(1)
}

// Signed only once the deploy is going to happen, so a refusal never mints a readable
// URL for artifacts nobody published.
const publish = []
for (const artifact of wanted) {
  const canvas = canvases.find((c) => c.name === artifact.canvas_name)
  publish.push({
    canvas: artifact.canvas_name ?? 'unknown',
    relative_path: artifact.relative_path,
    signed_url: await sign(artifact.storage_key),
    // Carried so the box can check what it downloaded against what was promised. The
    // skill has always required that check; nothing supplied the number to make it.
    bytes: artifact.bytes ?? 0,
    width: canvas?.width ?? 0,
    height: canvas?.height ?? 0,
  })
}

const [run] = await rest<{ id: string }[]>('runs', {
  method: 'POST',
  body: JSON.stringify({ revision_id: revision.id, sandbox_provider: 'e2b', status: 'starting' }),
})
const [deployRun] = await rest<{ id: string }[]>('deploy_runs', {
  method: 'POST',
  body: JSON.stringify({ deployment_id: deployment.id, run_id: run.id, status: 'starting' }),
})
/**
 * Last run's evidence is cleared as this one starts.
 *
 * The outcome check below asks whether a url was read back off the page. It used to ask
 * that of a column nobody reset, so a redeploy that stopped early inherited the previous
 * attempt's url and passed a test it had never taken.
 */
await rest(`deployments?id=eq.${deployment.id}`, {
  method: 'PATCH',
  body: JSON.stringify({
    status: 'running',
    verified_url: null,
    verified_note: null,
    recording_artifact_id: null,
  }),
})

/**
 * Marks the rows this run already created, then hands back the error to throw.
 *
 * Everything between here and a live box is an invariant check that should never fire —
 * which is exactly why each was left to throw into a bare stack trace. The run and
 * deploy_run rows were inserted moments ago, so an uncaught throw strands both at
 * `starting` forever and the Deploy screen shows a deploy that is still going.
 *
 * Returned rather than thrown so the caller writes `throw await abandoned(...)`: that
 * keeps the control flow visible at the call site, and lets the compiler see the path
 * ends there.
 */
async function abandoned(reason: string): Promise<Error> {
  const ended_at = new Date().toISOString()
  const failed = JSON.stringify({ status: 'failed', exit_reason: reason.slice(0, 200), ended_at })
  await rest(`runs?id=eq.${run.id}`, { method: 'PATCH', body: failed }).catch(() => {})
  await rest(`deploy_runs?id=eq.${deployRun.id}`, { method: 'PATCH', body: failed }).catch(() => {})
  await rest(`deployments?id=eq.${deployment.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'failed',
      verified_note: `did not start — ${reason}`.slice(0, 500),
    }),
  }).catch(() => {})
  return new Error(reason)
}

const hydration = buildDeploymentHydration({
  runId: run.id,
  revisionId: revision.id,
  brandKitId: deployment.kit_id,
  publish,
  campaignName: request.campaign_name,
  copy: request.copy ?? {},
  target: {
    tool: deployment.target_tool,
    entry_url: deployment.target_url,
    credential_env: ['DEPLOY_USERNAME', 'DEPLOY_PASSWORD'],
    campaign: deployment.target_campaign,
    objective: deployment.target_objective,
    notes: deployment.target_notes,
    // The derived map, not the raw column: Primary text and Ad name are resolved above
    // so the box is handed every value the form asks for.
    fields,
  },
})

/**
 * The hydration file is saved for audit, so it must name credentials and never carry
 * them. Two checks, because one of them cannot work.
 *
 * Scanning for a secret's *value* only works when the value is high-entropy. The demo
 * deploy password is the word `adstream`, which is also the tool's name and part of its
 * hostname — so a value scan flagged a perfectly correct file and refused to launch.
 * A short or dictionary-word secret is undetectable this way, and pretending otherwise
 * produces false confidence in one direction and false alarms in the other.
 *
 * So: value-scan only the long random secrets, and check the credential fields
 * structurally — they must contain variable *names*, and the file must have no field
 * that looks like it holds a password at all.
 */
const serialised = JSON.stringify(hydration)
for (const secret of [env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_JWT_SECRET, env.OPENAI_API_KEY]) {
  if (secret && secret.length >= 20 && serialised.includes(secret)) {
    throw await abandoned('refusing to launch: a high-entropy secret appears in the hydration file')
  }
}
for (const name of hydration.target.credential_env) {
  if (!/^[A-Z0-9_]+$/.test(name)) {
    throw await abandoned(`credential_env must hold variable names, got ${JSON.stringify(name)}`)
  }
  if (process.env[name] && name === process.env[name]) {
    throw await abandoned(`credential_env entry ${name} looks like a value, not a name`)
  }
}
if (/"(password|secret|token|api_key)"\s*:\s*"[^"]/i.test(serialised)) {
  throw await abandoned('refusing to launch: the hydration file has a field that holds a credential')
}

const token = mintRunToken(
  { run_id: run.id, revision_id: revision.id, brand_kit_id: deployment.kit_id },
  { secret: env.SUPABASE_JWT_SECRET as string, projectRef: PROJECT_REF, ttlSeconds: RUN_BUDGET_SECONDS },
)
/**
 * The deploy role, not the generation role.
 *
 * Minted by taking the run token's claims and swapping the role, so the two tokens are
 * identical in scope except for what they are allowed to do — which is the whole point
 * of having two roles. A deploy box may write a recording and read the artifacts it is
 * publishing, and nothing else.
 */
const claims = decodePayload(token)
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const deployToken = (() => {
  const header = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ ...claims, role: 'sandbox_deploy' })
  const signature = createHmac('sha256', env.SUPABASE_JWT_SECRET as string)
    .update(`${header}.${body}`)
    .digest()
    .toString('base64url')
  return `${header}.${body}.${signature}`
})()

const sandboxEnv: Record<string, string> = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY as string,
  CQ_RUN_TOKEN: deployToken,
  CQ_RUN_ID: run.id,
  CQ_REVISION_ID: revision.id,
  CQ_WORK_PREFIX: `${revision.request_id}/rev-${revision.n}`,
  CQ_WORK_DIR: '/home/user/work',
  CQ_RECORDING_DIR: '/home/user/work/deploy',
  CQ_AGENT_MODEL: env.CQ_AGENT_MODEL ?? 'gpt-5.6-sol',
  OPENAI_API_KEY: env.OPENAI_API_KEY as string,
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
  DEPLOY_USERNAME: env.DEPLOY_USERNAME ?? '',
  DEPLOY_PASSWORD: env.DEPLOY_PASSWORD ?? '',
}
for (const [key, value] of Object.entries(sandboxEnv)) {
  if (value === SERVICE_ROLE) throw await abandoned(`refusing: ${key} carries service_role`)
  if (value === env.SUPABASE_JWT_SECRET) throw await abandoned(`refusing: ${key} carries the JWT secret`)
}

process.env.E2B_API_KEY = env.E2B_API_KEY
// A box that never came up is the last way to strand a `starting` row: the try/finally
// that would have marked it does not begin until there is a sandbox to run in.
const sandbox = await Sandbox.create('cq-deployment', {
  timeoutMs: RUN_BUDGET_SECONDS * 1000,
  envs: sandboxEnv,
}).catch(async (error: unknown) => {
  throw await abandoned(`could not create the sandbox: ${(error as Error).message}`)
})
console.log(`deployment ${deployment.name}\nsandbox ${sandbox.sandboxId}\npublishing ${publish.length} canvas(es)`)

await rest(`runs?id=eq.${run.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ sandbox_id: sandbox.sandboxId, status: 'running' }),
})
await rest(`deploy_runs?id=eq.${deployRun.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'running' }) })
await sandbox.files.write('/home/user/hydration.json', JSON.stringify(hydration, null, 2))

let exitReason = 'completed'
try {
  const result = await sandbox.commands.run('cd /home/user && ./node_modules/.bin/tsx agent.deploy.ts 2>&1', {
    timeoutMs: RUN_BUDGET_SECONDS * 1000,
    onStdout: (line: string) => { process.stdout.write(`  ${line}`) },
    onStderr: (line: string) => { process.stderr.write(`  ${line}`) },
  })
  if (result.exitCode !== 0) exitReason = `agent exited ${result.exitCode}`
} catch (error) {
  exitReason = `agent failed: ${(error as Error).message.slice(0, 200)}`
  console.error(`\n${exitReason}`)
} finally {
  let status = 'unverified'
  let recordingPath: string | null = null
  let verifiedUrl: string | null = null

  try {
    /**
     * This run's recording, not this revision's.
     *
     * Querying by `revision_id` alone counted an earlier deploy of the same revision as
     * this one's evidence, and pointed `recording_artifact_id` at the wrong video — two
     * runs in a row reported the same recording hash while each had saved its own.
     */
    const recordings = await rest<{ id: string; relative_path: string }[]>(
      `artifacts?run_id=eq.${run.id}&role=eq.recording&select=id,relative_path&order=created_at.desc`,
    )
    const [current] = await rest<
      { status: string; verified_url: string | null; verified_note: string | null }[]
    >(`deployments?id=eq.${deployment.id}&select=status,verified_url,verified_note`)

    // The agent's verdict is a ceiling: this confirms or downgrades it, never raises
    // it. The rule and the reason live in src/deploy-fields.ts, where they are tested.
    const evidenced = recordings.length > 0 && Boolean(current?.verified_url)
    status = resolveDeployStatus({
      exitReason,
      reported: current?.status ?? null,
      hasRecording: recordings.length > 0,
      hasVerifiedUrl: Boolean(current?.verified_url),
    })

    await rest(`deployments?id=eq.${deployment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        recording_artifact_id: recordings[0]?.id ?? null,
        // The agent's account survives where it wrote one. Overwriting a real blocker
        // with "no recording or no url read back" loses the only sentence that ever
        // explained the failure.
        verified_note:
          current?.verified_note?.trim() ||
          (evidenced ? 'recording saved and url read back' : 'no recording or no url read back'),
      }),
    })
    await rest(`deploy_runs?id=eq.${deployRun.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: exitReason === 'completed' ? 'completed' : 'failed',
        exit_reason: exitReason,
        ended_at: new Date().toISOString(),
      }),
    })
    await rest(`runs?id=eq.${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: exitReason === 'completed' ? 'completed' : 'failed', exit_reason: exitReason, ended_at: new Date().toISOString() }),
    })

    recordingPath = recordings[0]?.relative_path ?? null
    verifiedUrl = current?.verified_url ?? null
  } catch (error) {
    // Reported, not rethrown: a database that will not take the outcome is worth
    // knowing about, and it must not be the reason a sandbox is left running.
    console.error(`could not record the outcome: ${(error as Error).message}`)
  } finally {
    await sandbox.kill().catch(() => {})
  }

  console.log(`\n── deploy ${status}`)
  console.log(`   recording: ${recordingPath ?? 'NONE'}`)
  console.log(`   verified url: ${verifiedUrl ?? 'none'}`)
}
