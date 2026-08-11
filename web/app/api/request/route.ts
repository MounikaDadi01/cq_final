import { cookies } from 'next/headers'
import { startLauncher, verifyUserToken } from '@/lib/server'

/**
 * Create a request and start the first run.
 *
 * The request row is written with the *session* token, so a customer can only create
 * work against a kit it owns — the policy enforces it rather than this handler. Only
 * the launch needs the backend, because `app_user` deliberately cannot insert a run.
 */
export async function POST(request: Request) {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  const claims = token ? verifyUserToken(token) : null
  if (!claims) return Response.json({ error: 'not signed in' }, { status: 401 })

  const body = (await request.json()) as {
    kit_id?: string
    campaign_name?: string
    headline?: string
    subhead?: string
    eybrow?: string
    eyebrow?: string
    cta?: string
    plate_direction?: string
    canvases?: string[]
    inspirations?: string[]
  }

  const name = (body.campaign_name ?? '').trim()
  const headline = (body.headline ?? '').trim()
  if (!name || !headline) {
    return Response.json({ error: 'a campaign name and a headline are required' }, { status: 400 })
  }
  if (!body.kit_id || !/^[A-Za-z0-9._-]{1,64}$/.test(body.kit_id)) {
    return Response.json({ error: 'kit_id is not a valid id' }, { status: 400 })
  }

  const { env } = await import('@/lib/server')
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }

  // The four sizes the brief names. `producible` is decided by the launcher against
  // the model's envelope, so an impossible size is recorded rather than dropped.
  const ALL = [
    { name: 'square', width: 1080, height: 1080 },
    { name: 'landscape', width: 1200, height: 628 },
    { name: 'portrait', width: 1080, height: 1350 },
    { name: 'leaderboard', width: 728, height: 90 },
  ]
  const wanted = ALL.filter((c) => (body.canvases ?? ['square', 'landscape', 'portrait']).includes(c.name))
  if (wanted.length === 0) return Response.json({ error: 'pick at least one size' }, { status: 400 })

  const created = await fetch(`${SUPABASE_URL}/rest/v1/requests`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      kit_id: body.kit_id,
      kind: 'new',
      campaign_name: name,
      copy: {
        eyebrow: body.eyebrow ?? null,
        headline,
        subhead: body.subhead ?? null,
        cta: body.cta ?? 'Learn more',
        legal: null,
      },
      plate_direction: body.plate_direction ?? null,
      inspirations: body.inspirations ?? [],
      created_by: 'ui',
    }),
  })
  if (!created.ok) {
    return Response.json({ error: `could not create the request: ${await created.text()}` }, { status: 400 })
  }
  const [row] = (await created.json()) as { id: string }[]

  await fetch(`${SUPABASE_URL}/rest/v1/request_canvases`, {
    method: 'POST',
    headers,
    body: JSON.stringify(wanted.map((c) => ({ request_id: row.id, ...c }))),
  })

  const [revision] = (await (
    await fetch(`${SUPABASE_URL}/rest/v1/revisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request_id: row.id, n: 1, status: 'draft' }),
    })
  ).json()) as { id: string }[]

  // Waited on briefly so a refusal reaches the browser instead of vanishing.
  const started = await startLauncher(
    ['tsx', 'scripts/launch-run.ts', '--revision', revision.id, '--mode', 'revise', '--quality', 'high'],
    revision.id,
  )
  if (!started.ok) {
    return Response.json(
      {
        error: `the request was created but the run could not start: ${started.error}`,
        request_id: row.id,
        revision_id: revision.id,
      },
      { status: 500 },
    )
  }

  return Response.json({ ok: true, request_id: row.id, revision_id: revision.id })
}

export const dynamic = 'force-dynamic'
