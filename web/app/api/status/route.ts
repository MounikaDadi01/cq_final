import { cookies } from 'next/headers'
import { env, verifyUserToken } from '@/lib/server'

/**
 * Progress for one request, so the UI can say how far along a run is.
 *
 * A run takes over a minute and the box is destroyed at the end. Without this the only
 * honest thing the UI could say was "started" — and someone watching an unchanging
 * screen for ninety seconds cannot tell a slow run from a dead one.
 *
 * Read with the session token, so the answer is filtered by the same policies as
 * everything else. A request belonging to another customer returns nothing.
 */
export async function GET(request: Request) {
  const store = await cookies()
  const token = store.get('cq_session')?.value
  if (!token || !verifyUserToken(token)) {
    return Response.json({ error: 'not signed in' }, { status: 401 })
  }

  const params = new URL(request.url).searchParams
  const requestId = params.get('request')
  const deploymentId = params.get('deployment')
  const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = env()
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
  const get = (path: string) =>
    fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers, cache: 'no-store' }).then((r) => r.json())

  /**
   * Deployment progress, on the same terms as a render's.
   *
   * A deploy is worse than a render for watching, not better: it runs a minute or
   * more, and for most of that the agent is reading a page and clicking, which
   * changes nothing anywhere the browser can see. So the honest signals are the
   * few that do land in the database — the run row, then the recording, then the
   * url read back off the tool's own page — and the UI says which of those have
   * happened rather than implying continuous motion.
   *
   * Read with the session token, so a deployment belonging to another customer
   * returns nothing here for the same reason it does not appear in any list.
   */
  if (deploymentId) {
    if (!UUID.test(deploymentId)) {
      return Response.json({ error: 'deployment must be a uuid' }, { status: 400 })
    }
    const deployments = await get(
      `deployments?id=eq.${deploymentId}` +
        '&select=id,name,status,verified_url,verified_note,recording_artifact_id,updated_at',
    )
    const deployment = Array.isArray(deployments) ? deployments[0] : null
    if (!deployment) return Response.json({ deployment: null })

    const [runs, items] = await Promise.all([
      get(
        `deploy_runs?deployment_id=eq.${deploymentId}` +
          '&select=id,run_id,status,exit_reason,started_at,ended_at&order=started_at.desc&limit=1',
      ),
      get(`deployment_items?deployment_id=eq.${deploymentId}&select=id,revision_id`),
    ])

    const run = Array.isArray(runs) ? (runs[0] ?? null) : null

    /**
     * Findings for *this* run only, joined through the run row.
     *
     * The first version of this query had no filter at all, so it returned the
     * customer's most recent findings from any source — which on a deploy panel
     * meant showing render findings from hours earlier as though the deploy had
     * just produced them. Wrong context is worse than no context: every one of
     * those rows was true when written, which is exactly what makes them
     * convincing in the wrong place.
     */
    const findings = run
      ? await get(`findings?run_id=eq.${run.run_id ?? run.id}&select=code,severity,detail&limit=6`)
      : []

    return Response.json({
      deployment: {
        id: deployment.id,
        name: deployment.name,
        status: deployment.status,
        verifiedUrl: deployment.verified_url,
        verifiedNote: deployment.verified_note,
        // A boolean, not the id: whether evidence exists is the question, and the
        // id would be an artifact reference the caller has no use for here.
        recorded: Boolean(deployment.recording_artifact_id),
        updatedAt: deployment.updated_at,
      },
      run,
      items: Array.isArray(items) ? items.length : 0,
      findings: Array.isArray(findings) ? findings.slice(0, 4) : [],
    })
  }

  if (!requestId || !UUID.test(requestId)) {
    return Response.json({ error: 'request or deployment must be a uuid' }, { status: 400 })
  }

  const revisions = await get(
    `revisions?request_id=eq.${requestId}&select=id,n,status,approved_at&order=n.desc`,
  )
  const latest = Array.isArray(revisions) ? revisions[0] : null
  if (!latest) return Response.json({ revisions: [], latest: null })

  const [runs, artifacts] = await Promise.all([
    get(
      `runs?revision_id=eq.${latest.id}&select=status,exit_reason,saved_partial,started_at,ended_at&order=started_at.desc&limit=1`,
    ),
    get(`artifacts?revision_id=eq.${latest.id}&select=role,canvas_name`),
  ])

  const list: { role: string; canvas_name: string | null }[] = Array.isArray(artifacts) ? artifacts : []
  return Response.json({
    revisionCount: Array.isArray(revisions) ? revisions.length : 0,
    latest: {
      id: latest.id,
      n: latest.n,
      status: latest.status,
      approved: Boolean(latest.approved_at),
      run: Array.isArray(runs) ? (runs[0] ?? null) : null,
      // Counted by role so the UI can describe the stage a run is at, not merely that
      // it is going: plates first, then renders, then the result file.
      plates: list.filter((a) => a.role === 'plate').length,
      renders: list.filter((a) => a.role === 'render').length,
      artifacts: list.length,
    },
  })
}

export const dynamic = 'force-dynamic'
