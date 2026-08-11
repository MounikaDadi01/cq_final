import { cookies } from 'next/headers'
import { env, serviceFetch, startLauncher, verifyUserToken } from '@/lib/server'

/**
 * Start a run for a revision the signed-in customer owns.
 *
 * This route exists because a person may not start runs — `app_user` has no insert on
 * `runs`, deliberately. So the browser asks, and the backend decides. That means the
 * ownership check cannot be skipped here: this is the one place holding a credential
 * that ignores RLS, so it has to re-establish by hand what RLS would have enforced.
 *
 * Two kinds of work, priced differently:
 *
 *   rerender  — same plate, new layout. Free, seconds.
 *   revise    — a new revision with the open comments as the instruction. Costs an
 *               image call per canvas.
 */
export async function POST(request: Request) {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  if (!token) return Response.json({ error: 'not signed in' }, { status: 401 })

  // Signature first. Everything below trusts `customer_id`, and this route holds
  // the one credential that ignores row-level security.
  const claims = verifyUserToken(token)
  if (!claims) return Response.json({ error: 'not signed in' }, { status: 401 })
  const customerId = claims.customer_id

  const body = (await request.json()) as { revision_id?: string; mode?: string }
  const { revision_id, mode = 'revise' } = body

  // Both values end up in an argv, so both are checked against a closed set rather
  // than trusted for having the right TypeScript type — a compile-time type says
  // nothing about what arrives over the wire. An id like `--allow-stale` would
  // otherwise be read as a flag by the launcher.
  if (mode !== 'rerender' && mode !== 'revise') {
    return Response.json({ error: 'mode must be rerender or revise' }, { status: 400 })
  }
  if (typeof revision_id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(revision_id)) {
    return Response.json({ error: 'revision_id must be a uuid' }, { status: 400 })
  }

  // Ownership, checked against the session rather than trusted from the request.
  // A privileged connection with an unchecked id is exactly how a tenant boundary
  // gets crossed by an ordinary bug.
  const rows = await serviceFetch(
    `/rest/v1/revisions?id=eq.${revision_id}&select=id,n,request_id,requests(kit_id,campaign_name,brand_kits(customer_id))`,
  )
  const revision = Array.isArray(rows) ? rows[0] : null
  if (!revision) return Response.json({ error: 'no such revision' }, { status: 404 })

  const owner = revision.requests?.brand_kits?.customer_id
  if (owner !== customerId) {
    // Deliberately the same 404 as a missing revision. Telling the caller it exists
    // but belongs to someone else is itself a disclosure.
    return Response.json({ error: 'no such revision' }, { status: 404 })
  }

  const { CQ_LAUNCH_CAMPAIGN } = env()
  const campaign = String(CQ_LAUNCH_CAMPAIGN ?? revision.requests?.campaign_name ?? '')
  // The campaign name comes from the database, which is not the same as being safe:
  // a name beginning with `-` would be read as a flag. Passed as a flag value so it
  // can never be positional, and refused outright if it looks like one.
  if (!campaign || campaign.startsWith('-')) {
    return Response.json({ error: 'campaign name is unusable' }, { status: 400 })
  }

  // Detached so a ninety-second run does not hold the HTTP request open. Progress is
  // read from the run row and the artifacts as they land, which is also how a browser
  // that was closed mid-run catches up.
  const started = await startLauncher(
    [
      'tsx',
      'scripts/launch-run.ts',
      '--revision',
      revision_id,
      '--mode',
      mode,
      '--quality',
      mode === 'rerender' ? 'low' : 'high',
    ],
    revision_id,
  )
  if (!started.ok) {
    return Response.json({ error: `the run could not start: ${started.error}` }, { status: 500 })
  }

  return Response.json({ ok: true, mode, revision_id, started: true })
}

export const dynamic = 'force-dynamic'
