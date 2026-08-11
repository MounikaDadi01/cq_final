import { cookies } from 'next/headers'
import { env, serviceFetch, startLauncher, verifyUserToken } from '@/lib/server'

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/**
 * Create a deployment, or run one.
 *
 * The create half goes through the session token, so policy decides: a deployment can
 * only name a kit this customer owns, and an item can only reference an **approved**
 * revision they own. Both are database rules rather than checks in this handler.
 *
 * The run half needs the backend, because starting a run is not something a person may
 * do — and because it is privileged, ownership is re-established here by hand.
 */
export async function POST(request: Request) {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  const claims = token ? verifyUserToken(token) : null
  if (!claims) return Response.json({ error: 'not signed in' }, { status: 401 })

  const body = (await request.json()) as {
    name?: string
    revision_id?: string
    target_campaign?: string | null
    target_objective?: string | null
    target_fields?: Record<string, string>
    canvas_name?: string | null
  }
  const name = (body.name ?? '').trim()
  if (!name) return Response.json({ error: 'a name is required' }, { status: 400 })
  if (!body.revision_id || !UUID.test(body.revision_id)) {
    return Response.json({ error: 'revision_id must be a uuid' }, { status: 400 })
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }

  // The kit comes from the revision rather than the request body, so a caller cannot
  // point a deployment at a kit by naming one.
  const revisions = await fetch(
    `${SUPABASE_URL}/rest/v1/revisions?id=eq.${body.revision_id}&select=id,approved_at,requests(kit_id)`,
    { headers, cache: 'no-store' },
  ).then((r) => r.json())
  const revision = Array.isArray(revisions) ? revisions[0] : null
  if (!revision) return Response.json({ error: 'no such revision' }, { status: 404 })
  if (!revision.approved_at) {
    return Response.json({ error: 'only an approved revision can be deployed' }, { status: 400 })
  }

  const created = await fetch(`${SUPABASE_URL}/rest/v1/deployments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kit_id: revision.requests.kit_id,
      name,
      target_tool: 'adstream',
      target_url: env().DEPLOY_ENTRY_URL ?? 'https://adstream.bhairav.workers.dev/',
      target_campaign: body.target_campaign ?? null,
      target_objective: body.target_objective ?? null,
      // Blank values are kept rather than stripped: the agent stops on an empty
      // required field, which is the behaviour we want, and dropping the key would
      // make it look as though the tool never asked.
      target_fields: body.target_fields ?? {},
    }),
  })
  if (!created.ok) {
    return Response.json({ error: `could not create: ${(await created.text()).slice(0, 200)}` }, { status: 400 })
  }
  const [deployment] = (await created.json()) as { id: string }[]

  /**
   * Which canvas ships, and why it has to be one.
   *
   * `canvas_name` was in the schema and the launcher already filtered on it, but
   * nothing ever set it — so every deployment carried all three canvases of a
   * revision into a creative step that offers a single image upload, and the agent
   * stopped rather than choosing one on the customer's behalf. That refusal was
   * right; the missing part was letting a person say which one.
   *
   * Null is still allowed and still means "everything on this revision", because a
   * tool that accepts several images is a reasonable thing to meet later. It is the
   * caller's explicit choice rather than an accident of the form.
   */
  const canvasName =
    typeof body.canvas_name === 'string' && body.canvas_name.trim() ? body.canvas_name.trim() : null

  const item = await fetch(`${SUPABASE_URL}/rest/v1/deployment_items`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deployment_id: deployment.id,
      revision_id: body.revision_id,
      canvas_name: canvasName,
    }),
  })
  if (!item.ok) {
    return Response.json({ error: `could not add the revision: ${(await item.text()).slice(0, 200)}` }, { status: 400 })
  }

  return Response.json({ ok: true, deployment_id: deployment.id })
}

export async function PATCH(request: Request) {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  const claims = token ? verifyUserToken(token) : null
  if (!claims) return Response.json({ error: 'not signed in' }, { status: 401 })

  const { deployment_id } = (await request.json()) as { deployment_id?: string }
  if (!deployment_id || !UUID.test(deployment_id)) {
    return Response.json({ error: 'deployment_id must be a uuid' }, { status: 400 })
  }

  // Privileged from here, so ownership is checked explicitly. Same 404 for "not yours"
  // as for "does not exist" — confirming it exists is itself a disclosure.
  const rows = await serviceFetch(
    `/rest/v1/deployments?id=eq.${deployment_id}&select=id,kit_id,brand_kits(customer_id)`,
  )
  const deployment = Array.isArray(rows) ? rows[0] : null
  if (!deployment || deployment.brand_kits?.customer_id !== claims.customer_id) {
    return Response.json({ error: 'no such deployment' }, { status: 404 })
  }

  const started = await startLauncher(
    ['tsx', 'scripts/launch-deploy.ts', '--deployment', deployment_id],
    `deploy-${deployment_id}`,
  )
  if (!started.ok) {
    return Response.json({ error: `the deploy could not start: ${started.error}` }, { status: 500 })
  }

  return Response.json({ ok: true, started: true })
}

export const dynamic = 'force-dynamic'
