import { cookies } from 'next/headers'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { env, serviceFetch, verifyUserToken } from '@/lib/server'

/**
 * The raw log of one run, for watching a render happen and for debugging when it does not.
 *
 * Reads the file the launcher writes, which contains the sandbox's own stdout — so this is
 * the agent's live output, not a summary of it. That is the point: a summary is what the
 * UI already shows, and it is useless when the thing you need to know is why a tool call
 * failed.
 *
 * Ownership is checked before a byte is returned. A log names storage keys, model
 * decisions and finding text, so serving one for another customer's revision would leak
 * exactly the things the rest of the system is careful about.
 */
export async function GET(request: Request) {
  if (env().CQ_DEV_LOGS !== '1') {
    // Off by default so it cannot be reached during a demo by guessing the path.
    return Response.json({ error: 'developer logs are disabled' }, { status: 404 })
  }

  const store = await cookies()
  const token = store.get('cq_session')?.value
  const claims = token ? verifyUserToken(token) : null
  if (!claims) return Response.json({ error: 'not signed in' }, { status: 401 })

  const params = new URL(request.url).searchParams
  const revisionId = params.get('revision')
  const deploymentId = params.get('deployment')
  const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

  /**
   * Two kinds of run write logs, and both are worth reading for the same reason.
   *
   * A deploy log is arguably the more useful of the two: a render that goes wrong
   * leaves an image to look at, while a deploy that goes wrong leaves a tool in an
   * unknown state, and the only account of what the agent clicked is this file.
   *
   * Ownership is re-established per kind before any byte is served. The log names
   * storage keys, model decisions and finding text, so the check is not a formality.
   */
  let logName: string
  if (deploymentId) {
    if (!UUID.test(deploymentId)) {
      return Response.json({ error: 'deployment must be a uuid' }, { status: 400 })
    }
    const rows = await serviceFetch(
      `/rest/v1/deployments?id=eq.${deploymentId}&select=id,brand_kits(customer_id)`,
    )
    const deployment = Array.isArray(rows) ? rows[0] : null
    if (!deployment || deployment.brand_kits?.customer_id !== claims.customer_id) {
      return Response.json({ error: 'no such deployment' }, { status: 404 })
    }
    // Matches the name the deploy route passes to the launcher.
    logName = `deploy-${deploymentId}`
  } else {
    if (!revisionId || !UUID.test(revisionId)) {
      return Response.json({ error: 'revision or deployment must be a uuid' }, { status: 400 })
    }
    const rows = await serviceFetch(
      `/rest/v1/revisions?id=eq.${revisionId}&select=id,requests(brand_kits(customer_id))`,
    )
    const revision = Array.isArray(rows) ? rows[0] : null
    if (!revision || revision.requests?.brand_kits?.customer_id !== claims.customer_id) {
      return Response.json({ error: 'no such revision' }, { status: 404 })
    }
    logName = revisionId
  }

  const path = join(process.cwd(), '.launch-logs', `${logName}.log`)
  if (!existsSync(path)) {
    return Response.json({ log: '', note: 'no log yet — this has not been run from the UI' })
  }
  // Tail only. A full run is tens of kilobytes and the interesting part is the end.
  const text = readFileSync(path, 'utf8')
  return Response.json({ log: text.slice(-24_000), bytes: text.length })
}

export const dynamic = 'force-dynamic'
