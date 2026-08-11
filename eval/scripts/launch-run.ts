/**
 * Launch one generation run in a real sandbox.
 *
 * This is the backend half. It holds `service_role`, creates the rows, mints a
 * narrow token, starts a box, and then stops being involved — the agent writes its
 * own work out through its own credential. Nothing here reaches into the box to
 * collect anything, and that is the constraint the whole design is built around.
 *
 * What it must never do, and each has a check rather than a comment:
 *
 *   · put `service_role` into the sandbox environment
 *   · name a box after a tenant or a task
 *   · push the brand files in (the box pulls them, so every run tests its own RLS)
 *
 *   npx tsx scripts/launch-run.ts <campaign-id> [--quality low]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Sandbox } from 'e2b'
import { groundSwitchPoint, loadBrain, resolveFamily, resolveScaleValue } from '../src/brain'
import { GPT_IMAGE_2, planGeneration } from '../src/capability'
import { discoverCampaigns } from '../src/campaign'
import { buildGenerationHydration, hydrationGaps, hydrationLeaks, RUN_BUDGET_SECONDS } from '../src/hydration'
import { mintRunToken, decodePayload } from '../src/rls'
import { readEnvFile } from '../src/openai-image'
import { checkStamp } from '../../sandbox/check-stamp'

const ROOT = join(import.meta.dirname, '..', '..')
const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env }

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET', 'E2B_API_KEY', 'OPENAI_API_KEY']
for (const key of required) if (!env[key]) throw new Error(`${key} missing from .env`)

const SUPABASE_URL = env.SUPABASE_URL as string
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY as string
const PROJECT_REF = decodePayload(env.SUPABASE_ANON_KEY as string).ref as string

/**
 * Refuse to launch against a stale image.
 *
 * Editing the agent and forgetting to rebuild produced `ERR_MODULE_NOT_FOUND` for a
 * file that was plainly on disk, twice. That reads as a path bug rather than a
 * staleness bug, and each occurrence cost a run to diagnose. `--allow-stale` exists
 * for the case where you know the image is fine and only a comment moved.
 */
// The generation image only. A change to the deploy agent cannot affect this box, and
// refusing to render because of one taught us to reach for `--allow-stale` instead.
const stamp = checkStamp('generation')
if (!stamp.fresh && !process.argv.includes('--allow-stale')) {
  console.error(`\nrefusing to launch — ${stamp.reason}`)
  for (const c of stamp.changed) console.error(`  changed: ${c}`)
  console.error('\n  rebuild:  npm run build --prefix sandbox')
  console.error('  override: --allow-stale\n')
  process.exit(1)
}
console.log(stamp.fresh ? `templates: ${stamp.reason}` : `templates: STALE, continuing on --allow-stale`)

const args = process.argv.slice(2)
/**
 * `--campaign <id>` is preferred over a positional.
 *
 * A positional argument beginning with `-` is indistinguishable from a flag, and this
 * value reaches here from a database column. The bare positional stays supported for
 * hand-running from a shell.
 */
const campaignFlag = args.indexOf('--campaign')
const campaignId =
  campaignFlag !== -1 ? args[campaignFlag + 1] : args.find((a) => !a.startsWith('-'))

/**
 * Continue an existing request instead of creating a new one.
 *
 * Without this every launch made a fresh request, so nine test runs produced nine
 * identically named requests and the sidebar became useless. Worse, it was wrong in
 * substance: pressing *Re-render* means "revision 2 of this work", not "a second
 * piece of work that happens to look the same". Revisions belong to a request.
 */
const revisionFlag = args.indexOf('--revision')
const continueRevision = revisionFlag !== -1 ? args[revisionFlag + 1] : null
const modeFlag = args.indexOf('--mode')
const runMode = (modeFlag !== -1 ? args[modeFlag + 1] : 'new') as 'new' | 'rerender' | 'revise'
const qualityFlag = args.indexOf('--quality')
const quality = (qualityFlag !== -1 ? args[qualityFlag + 1] : 'high') as 'low' | 'medium' | 'high'
if (!campaignId) throw new Error('usage: launch-run.ts --campaign <id> [--revision <id>] [--mode revise|rerender]')
if (!['low', 'medium', 'high'].includes(quality)) throw new Error(`bad quality: ${quality}`)

const headers = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` }

async function rest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : null) as T
}

// ---------------------------------------------------------------------------
// Resolve the request
// ---------------------------------------------------------------------------

/**
 * Where the request comes from.
 *
 * A first run reads a local campaign fixture. Continuing a revision reads the
 * database, because the request is already there — and matching a fixture by name
 * was the bug: the UI passes `campaign_name` while fixtures are keyed by id, so every
 * button press threw before it reached a sandbox.
 *
 * It is also the right shape regardless. A revision of work created through the UI has
 * no fixture on disk, and requiring one would mean the product only works for
 * campaigns a developer happened to write a file for.
 */
interface Job {
  brandKitId: string
  campaignName: string
  kind: 'new' | 'edit'
  copy: Record<string, string | null>
  plateDirection: string | null
  inspirations: string[]
  canvasSpecs: { name: string; width: number; height: number }[]
}

let job: Job

if (continueRevision) {
  const rows = await rest<
    {
      id: string
      n: number
      request_id: string
      requests: {
        kit_id: string
        campaign_name: string
        copy: Record<string, string | null>
        plate_direction: string | null
        inspirations: string[]
        request_canvases: { name: string; width: number; height: number; producible: boolean }[]
      }
    }[]
  >(
    `revisions?id=eq.${continueRevision}&select=id,n,request_id,requests(kit_id,campaign_name,copy,plate_direction,inspirations,request_canvases(name,width,height,producible))`,
  )
  const found = rows[0]
  if (!found) throw new Error(`no revision ${continueRevision}`)
  const r = found.requests
  job = {
    brandKitId: r.kit_id,
    campaignName: r.campaign_name,
    kind: 'edit',
    copy: r.copy ?? {},
    plateDirection: r.plate_direction,
    inspirations: r.inspirations ?? [],
    canvasSpecs: r.request_canvases.map((c) => ({ name: c.name, width: c.width, height: c.height })),
  }
  console.log(`continuing "${job.campaignName}" from rev ${found.n}`)
} else {
  const fixture = discoverCampaigns(join(ROOT, 'campaigns')).find((c) => c.id === campaignId)
  if (!fixture) throw new Error(`no campaign fixture named ${campaignId}`)
  job = {
    brandKitId: fixture.brandKitId,
    campaignName: fixture.campaign ?? fixture.id,
    kind: fixture.kind,
    copy: fixture.copy as unknown as Record<string, string | null>,
    plateDirection: fixture.plateDirection ?? null,
    inspirations: fixture.inspirations,
    canvasSpecs: fixture.canvases.map((c) => ({ name: c.name, width: c.width, height: c.height })),
  }
}

/**
 * The brand comes from storage, not from a folder on this machine.
 *
 * This used to scan `packet/design-brains` for a directory whose manifest matched the
 * kit id — which worked only for the two brands that ship with the packet. A customer
 * added through the UI has no local folder at all, so a perfectly good request failed
 * with `no brain for bk-…`, and the launcher was the only thing that knew why.
 *
 * Ingest has already put every brand file in the `brains` bucket under the kit's own
 * prefix. Pulling it down here means the launcher works for any ingested kit, from any
 * source, and the digests it records describe the same bytes the sandbox will fetch.
 */
async function materialiseBrain(kitId: string): Promise<string> {
  const listing = await fetch(`${SUPABASE_URL}/storage/v1/object/list/brains`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: `${kitId}/`, limit: 500 }),
  })
  if (!listing.ok) throw new Error(`could not list brains/${kitId}: ${listing.status}`)
  const entries = (await listing.json()) as { name: string }[]

  // Storage lists one level at a time, so directories come back as entries with no
  // extension and have to be walked.
  const files: string[] = []
  const walk = async (prefix: string, depth = 0) => {
    if (depth > 3) return
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/brains`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 500 }),
    })
    const rows = (await response.json()) as { name: string; id: string | null }[]
    for (const row of rows) {
      // A folder has no id in Supabase's listing; a file does.
      if (row.id === null) await walk(`${prefix}${row.name}/`, depth + 1)
      else files.push(`${prefix}${row.name}`)
    }
  }
  await walk(`${kitId}/`)
  if (files.length === 0) throw new Error(`brains/${kitId}/ is empty — has this kit been ingested?`)

  const dir = mkdtempSync(join(tmpdir(), `cq-brain-${kitId}-`))
  for (const key of files) {
    const relative = key.slice(kitId.length + 1)
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/brains/${key}`, { headers })
    if (!response.ok) throw new Error(`could not fetch ${key}: ${response.status}`)
    const target = join(dir, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, Buffer.from(await response.arrayBuffer()))
  }
  console.log(`brand: pulled ${files.length} file(s) from brains/${kitId}/`)
  return dir
}

const brainDir = await materialiseBrain(job.brandKitId)
const brain = loadBrain(brainDir)
/**
 * Which inspirations this run may actually use.
 *
 * Two gates, and both matter. The file has to exist under this kit's own prefix in
 * storage — which is what stops one brand reaching another's references at all — and its
 * name has to begin with this brand's slug, so a file's name and its location agree. A
 * file that passes one and not the other is refused and reported rather than quietly
 * used or quietly dropped.
 *
 * Previously these were pushed in from a folder on the machine running the launcher, so
 * a customer added through the UI could never have one and a run elsewhere silently had
 * none.
 */
const inspirationDir = join(brainDir, 'inspirations')
const availableInspirations = existsSync(inspirationDir) ? readdirSync(inspirationDir) : []

const brandSlugs = (() => {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const fromKit = clean(job.brandKitId).replace(/^bk-/, '').replace(/-\d{4}$/, '')
  return [...new Set([fromKit, clean(brain.slug ?? '')].filter(Boolean))]
})()

const namedForThisBrand = (file: string) =>
  brandSlugs.some((slug) => file.toLowerCase().startsWith(`${slug}-`) || file.toLowerCase().startsWith(`${slug}_`))

const usableInspirations: string[] = []
const inspirationNotes: string[] = []
for (const requested of job.inspirations) {
  if (!availableInspirations.includes(requested)) {
    inspirationNotes.push(`${requested} is not in brains/${job.brandKitId}/inspirations/`)
    continue
  }
  if (!namedForThisBrand(requested)) {
    inspirationNotes.push(`${requested} is not named for this brand (expected ${brandSlugs.join(' or ')}-…)`)
    continue
  }
  usableInspirations.push(requested)
}
for (const note of inspirationNotes) console.log(`   inspiration refused: ${note}`)
console.log(
  `inspirations: ${usableInspirations.length} of ${job.inspirations.length} requested usable` +
    `${availableInspirations.length ? ` (${availableInspirations.length} available for this kit)` : ' (none staged for this kit)'}`,
)

if (!brain.hasDesignDoc) {
  // A kit with no brand document cannot produce an ad, and the kit's ingest status
  // should already say `blocked`. Refusing here as well, because a run that started
  // anyway would produce something with no palette, no type and no scale.
  throw new Error(`${job.brandKitId} has no DESIGN.md in storage — it cannot be used`)
}

const kits = await rest<{ id: string; ingest_status: string }[]>(
  `brand_kits?id=eq.${encodeURIComponent(job.brandKitId)}&select=id,ingest_status`,
)
if (!kits.length) throw new Error(`${job.brandKitId} has not been ingested`)
// A half-ingested brand produces an ad missing a font, which looks fine and is
// wrong. Refusing here is cheaper than discovering it in the render.
if (kits[0].ingest_status !== 'ready') throw new Error(`${job.brandKitId} is ${kits[0].ingest_status}`)

const canvases = job.canvasSpecs.map((c) => {
  const plan = planGeneration(c.width, c.height, GPT_IMAGE_2)
  return {
    name: c.name,
    width: c.width,
    height: c.height,
    producible: plan.ok,
    ...(plan.ok ? {} : { refusal: plan.reasons[0] }),
  }
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface Parent {
  id: string
  n: number
  request_id: string
}

let request: { id: string }
let revision: { id: string; n: number }
let parent: Parent | null = null
/** Open comments become the edit instruction for a revise run. */
let editInstruction: string | null = null

if (continueRevision) {
  const found = await rest<Parent[]>(
    `revisions?id=eq.${continueRevision}&select=id,n,request_id`,
  )
  parent = found[0] ?? null
  if (!parent) throw new Error(`no revision ${continueRevision}`)
  request = { id: parent.request_id }

  /**
   * Execute an empty draft in place; make a successor for anything else.
   *
   * `--revision` means "run this work". When the target is a fresh draft with nothing
   * saved against it — which is what the UI creates for a new request — running it
   * means filling it in. Always creating a successor left revision 1 permanently empty
   * and started every new request at revision 2.
   */
  const saved = await rest<{ id: string }[]>(
    `artifacts?revision_id=eq.${parent.id}&select=id&limit=1`,
  )
  const targetStatus = await rest<{ status: string }[]>(
    `revisions?id=eq.${parent.id}&select=status`,
  )
  const isEmptyDraft = saved.length === 0 && targetStatus[0]?.status === 'draft'

  if (isEmptyDraft) {
    revision = { id: parent.id, n: parent.n }
    console.log(`executing empty draft rev ${parent.n} in place`)
  } else {
    const existing = await rest<{ n: number }[]>(
      `revisions?request_id=eq.${parent.request_id}&select=n&order=n.desc&limit=1`,
    )
    const next = (existing[0]?.n ?? parent.n) + 1
    ;[revision] = await rest<{ id: string; n: number }[]>('revisions', {
      method: 'POST',
      body: JSON.stringify({
        request_id: parent.request_id,
        n: next,
        parent_revision_id: parent.id,
        status: 'draft',
      }),
    })
  }

  // The instruction comes from what the person actually wrote on the artifact, not
  // from a flag. An open thread with no instruction contributes nothing.
  const threads = await rest<{ id: string; canvas_name: string | null }[]>(
    `comment_threads?request_id=eq.${parent.request_id}&status=eq.open&select=id,canvas_name`,
  )
  if (threads.length) {
    const notes = await rest<{ thread_id: string; instruction: string | null; body: string }[]>(
      `comment_messages?thread_id=in.(${threads.map((t) => t.id).join(',')})&author=eq.user&select=thread_id,instruction,body&order=created_at`,
    )
    const byThread = new Map(threads.map((t) => [t.id, t.canvas_name]))
    editInstruction =
      notes
        .map((m) => {
          const canvas = byThread.get(m.thread_id)
          return `${canvas ? `[${canvas}] ` : ''}${m.instruction ?? m.body}`
        })
        .join('\n') || null
  }
  console.log(
    `continuing request ${request.id} as rev ${revision.n}` +
      (editInstruction ? ` with ${editInstruction.split('\n').length} open comment(s)` : ' with no open comments'),
  )
} else {
  ;[request] = await rest<{ id: string }[]>('requests', {
    method: 'POST',
    body: JSON.stringify({
      kit_id: job.brandKitId,
      kind: job.kind,
      campaign_name: job.campaignName,
      copy: job.copy,
      plate_direction: job.plateDirection,
      inspirations: usableInspirations,
      created_by: 'launch-run.ts',
    }),
  })

  await rest('request_canvases', {
    method: 'POST',
    body: JSON.stringify(
      canvases.map((c) => ({
        request_id: request.id,
        name: c.name,
        width: c.width,
        height: c.height,
        producible: c.producible,
        refusal: c.refusal ?? null,
      })),
    ),
  })

  ;[revision] = await rest<{ id: string; n: number }[]>('revisions', {
    method: 'POST',
    body: JSON.stringify({ request_id: request.id, n: 1, status: 'draft' }),
  })
}

const [run] = await rest<{ id: string }[]>('runs', {
  method: 'POST',
  body: JSON.stringify({ revision_id: revision.id, sandbox_provider: 'e2b', status: 'starting' }),
})

console.log(`request ${request.id}\nrevision ${revision.id} (n=${revision.n})\nrun ${run.id}`)

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

const assets = await rest<{ kind: string; manifest_path: string; storage_key: string | null; available: boolean; notes: string | null }[]>(
  `brand_assets?kit_id=eq.${encodeURIComponent(job.brandKitId)}&available=is.true&select=kind,manifest_path,storage_key,available,notes`,
)
const fonts = await rest<{ family_slug: string; weight: number; storage_key: string }[]>(
  `brand_fonts?kit_id=eq.${encodeURIComponent(job.brandKitId)}&select=family_slug,weight,storage_key`,
)
const kitFindings = await rest<{ code: string; severity: string; detail: string }[]>(
  `findings?kit_id=eq.${encodeURIComponent(job.brandKitId)}&revision_id=is.null&select=code,severity,detail`,
)

const digestOf = (relativePath: string) => {
  try {
    return createHash('sha256').update(readFileSync(join(brainDir, relativePath))).digest('hex')
  } catch {
    return undefined
  }
}

const kitFiles = [
  { path: 'DESIGN.md', storageKey: `${job.brandKitId}/DESIGN.md`, purpose: 'the brand — outranks everything, including the request' },
  { path: 'README.md', storageKey: `${job.brandKitId}/README.md`, purpose: 'what each file is, and its authority' },
  { path: 'brand/asset_manifest.json', storageKey: `${job.brandKitId}/brand/asset_manifest.json`, purpose: 'staged assets, already filtered to this kit' },
  ...assets.map((a) => ({ path: a.manifest_path, storageKey: a.storage_key as string, purpose: `${a.kind}${a.notes ? ` — ${a.notes}` : ''}` })),
  ...fonts.map((f) => ({ path: f.storage_key.slice(job.brandKitId.length + 1), storageKey: f.storage_key, purpose: `${f.family_slug} ${f.weight}` })),
].map((f) => ({ ...f, digest: digestOf(f.path) }))

const heading = resolveFamily(brain, brain.type.heading ?? '')
const body = resolveFamily(brain, brain.type.body ?? '')
const h1 = resolveScaleValue(brain, 'h1')
const switchPoint = groundSwitchPoint(brain)

const hydration = buildGenerationHydration({
  runId: run.id,
  revisionId: revision.id,
  brandKitId: job.brandKitId,
  // A first run on an empty draft is a `new` task even though it arrived by
  // `--revision`: there is no parent output to revise.
  task: parent && parent.id !== revision.id ? 'edit' : 'new',
  parentRevisionId: parent && parent.id !== revision.id ? parent.id : null,
  editInstruction: parent && parent.id !== revision.id ? editInstruction : null,
  campaignName: job.campaignName,
  copy: job.copy,
  plateDirection: job.plateDirection,
  inspirations: usableInspirations,
  inspirationKeys: usableInspirations.map((name) => ({ path: name, storageKey: '' })),
  canvases,
  kitFiles,
  resolved: {
    palette: brain.palette,
    type_scale: brain.typeScale,
    heading_family: heading.resolvedFamilySlug ?? null,
    body_family: body.resolvedFamilySlug ?? null,
    heading_substituted: heading.substituted,
    heading_note: heading.reason ?? null,
    contested: h1?.contested ? [`h1 resolved to ${h1.value} from ${h1.source}; the kit states it twice`] : [],
    ground_switch_point: { value: switchPoint.value, source: switchPoint.source },
  },
  knownFindings: [
    ...kitFindings.map((f) => ({ code: f.code, severity: f.severity as never, detail: f.detail })),
    ...inspirationNotes.map((detail) => ({
      code: 'inspiration-refused',
      severity: 'review' as never,
      detail,
    })),
  ],
  // On an edit the parent's tree is mounted, so the agent can see what it is being
  // asked to change instead of inferring it from the instruction alone.
  parent: parent && parent.id !== revision.id
    ? {
        revision_id: parent.id,
        n: parent.n,
        tree: (
          await rest<{ relative_path: string; role: string; canvas_name: string | null; storage_key: string }[]>(
            `artifacts?revision_id=eq.${parent.id}&select=relative_path,role,canvas_name,storage_key&order=relative_path`,
          )
        ).map((a) => ({
          relative_path: a.relative_path,
          role: a.role,
          canvas: a.canvas_name,
          signed_url: '',
        })),
        findings: [],
      }
    : null,
  quality,
})

// Inspirations stay in the mount list even though the launcher pushes them rather
// than the box pulling them: no kit owns an inspiration, so there is no kit prefix
// to read it from. `lifetime: 'job'` with no storage key says exactly that, and the
// box's pull step skips anything without a key.
//
// Stripping them instead — which is what I tried first — made the manifest disagree
// with what actually lands in the box, and the gap check refused to launch. Correctly:
// a hydration file that under-reports its own contents cannot be audited.

const gaps = hydrationGaps(hydration)
if (gaps.length) throw new Error(`hydration is incomplete:\n  ${gaps.join('\n  ')}`)

const leaks = hydrationLeaks(hydration, {
  secrets: required.map((k) => env[k] as string),
  brandNames: [],
})
// Refuse to launch rather than discover a leaked credential in a saved artifact.
if (leaks.length) throw new Error(`hydration leaks:\n  ${leaks.join('\n  ')}`)

console.log(`hydration: ${hydration.mounts.length} mounts, ${kitFiles.length} kit files, no gaps, no leaks`)

/**
 * Optionally keep a copy of exactly what went into the box.
 *
 * `--dump-hydration <dir>` writes the same bytes that are about to be uploaded, so a
 * run can be audited after the box is gone. Off by default: the hydration names signed
 * URLs, and writing it to disk on every run would leave credentials lying around for
 * no reason.
 *
 * The filename carries the kit and revision because the point of collecting these is
 * usually to compare two of them — two tenants running at once should produce two
 * files with nothing of each other's in them.
 */
const dumpFlag = process.argv.indexOf('--dump-hydration')
if (dumpFlag !== -1 && process.argv[dumpFlag + 1]) {
  const dir = process.argv[dumpFlag + 1]
  mkdirSync(dir, { recursive: true })
  const name = `hydration-${job.brandKitId}-rev${revision.n}.json`
  writeFileSync(join(dir, name), JSON.stringify(hydration, null, 2))
  console.log(`dumped ${name}`)
}

// ---------------------------------------------------------------------------
// The box
// ---------------------------------------------------------------------------

const token = mintRunToken(
  { run_id: run.id, revision_id: revision.id, brand_kit_id: job.brandKitId },
  { secret: env.SUPABASE_JWT_SECRET as string, projectRef: PROJECT_REF, ttlSeconds: RUN_BUDGET_SECONDS },
)

const sandboxEnv: Record<string, string> = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY as string,
  CQ_RUN_TOKEN: token,
  CQ_RUN_ID: run.id,
  CQ_REVISION_ID: revision.id,
  CQ_WORK_PREFIX: `${request.id}/rev-${revision.n}`,
  CQ_WORK_DIR: '/home/user/work',
  CQ_AGENT_MODEL: env.CQ_AGENT_MODEL ?? 'gpt-5.6-sol',
  OPENAI_API_KEY: env.OPENAI_API_KEY as string,
  OPENAI_IMAGE_MODEL: env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
}

// Asserted, not assumed. `service_role` bypasses RLS entirely, so its presence in
// a box would void every guarantee this system makes at once — which is exactly
// why it gets a check of its own rather than a careful habit.
for (const [key, value] of Object.entries(sandboxEnv)) {
  if (value === SERVICE_ROLE) throw new Error(`refusing to launch: ${key} carries the service_role key`)
  if (value === env.SUPABASE_JWT_SECRET) throw new Error(`refusing to launch: ${key} carries the JWT signing secret`)
}

process.env.E2B_API_KEY = env.E2B_API_KEY

const sandbox = await Sandbox.create('cq-generation', {
  timeoutMs: RUN_BUDGET_SECONDS * 1000,
  envs: sandboxEnv,
})
// The provider's own handle, unmodified. A name we composed would be the place a
// tenant or a campaign leaked into box identity.
console.log(`sandbox ${sandbox.sandboxId} (identity is the provider's handle, names nothing)`)

await rest(`runs?id=eq.${run.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ sandbox_id: sandbox.sandboxId, status: 'running' }),
})
await rest(`revisions?id=eq.${revision.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'running' }) })

await sandbox.files.write('/home/user/hydration.json', JSON.stringify(hydration, null, 2))

for (const name of usableInspirations) {
  const bytes = readFileSync(join(inspirationDir, name))
  // Copied into a fresh ArrayBuffer: the SDK takes ArrayBuffer, and a Buffer's
  // backing store may be a shared pool slice rather than its own buffer.
  const body = new Uint8Array(bytes.byteLength)
  body.set(bytes)
  await sandbox.files.write(`/home/user/inspirations/${name}`, body.buffer as ArrayBuffer)
}
console.log(`wrote hydration.json and ${usableInspirations.length} inspiration(s)`)

const started = Date.now()
let exitReason = 'completed'
try {
  const result = await sandbox.commands.run('cd /home/user && ./node_modules/.bin/tsx agent.generate.ts 2>&1', {
    timeoutMs: RUN_BUDGET_SECONDS * 1000,
    // Streamed so a twenty-minute run is watchable rather than a silence that
    // ends in a verdict. Wrapped to return void — the SDK's callback type is
    // strict about it and `write()` returns a boolean.
    onStdout: (line: string) => {
      process.stdout.write(`  ${line}`)
    },
    onStderr: (line: string) => {
      process.stderr.write(`  ${line}`)
    },
  })
  if (result.exitCode !== 0) exitReason = `agent exited ${result.exitCode}`
} catch (error) {
  exitReason = `agent failed: ${(error as Error).message.slice(0, 200)}`
  console.error(`\n${exitReason}`)
} finally {
  const seconds = Math.round((Date.now() - started) / 1000)

  // What the run actually produced, read from the record rather than from the box.
  const artifacts = await rest<{ relative_path: string; role: string; bytes: number }[]>(
    `artifacts?revision_id=eq.${revision.id}&select=relative_path,role,bytes&order=relative_path`,
  )
  const [finalRevision] = await rest<{ status: string }[]>(`revisions?id=eq.${revision.id}&select=status`)

  await rest(`runs?id=eq.${run.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: exitReason === 'completed' ? 'completed' : 'failed',
      ended_at: new Date().toISOString(),
      exit_reason: exitReason,
      saved_partial: finalRevision?.status === 'partial',
    }),
  })

  await sandbox.kill()

  console.log(`\n── run ${exitReason} in ${seconds}s, box killed`)
  console.log(`   revision status: ${finalRevision?.status}`)
  console.log(`   artifacts recorded: ${artifacts.length}`)
  for (const a of artifacts) console.log(`     ${a.role.padEnd(9)} ${a.relative_path}  ${a.bytes}B`)
  if (finalRevision?.status === 'partial') {
    console.log('   PARTIAL — some work saved, the revision is not complete')
  }
}
