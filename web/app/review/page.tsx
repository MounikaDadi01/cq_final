import { redirect } from 'next/navigation'
import {
  read,
  session,
  sign,
  type Artifact,
  type Canvas,
  type Finding,
  type Message,
  type RequestRow,
  type Revision,
  type Thread,
} from '@/lib/read'
import { env } from '@/lib/server'
import ReviewClient from './review-client'

/**
 * Review, server side.
 *
 * Every read below uses the browser's own session token, so the page can only ever
 * render what that customer is allowed to see. Signed URLs are minted here too,
 * because a private bucket cannot be shown any other way and the signature has to be
 * made by a credential the policy already accepted.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; canvas?: string }>
}) {
  const current = await session()
  if (!current) redirect('/')
  const { token, customerId } = current
  const params = await searchParams

  const requests = await read<RequestRow[]>(
    token,
    'requests?select=id,kit_id,campaign_name,kind,copy,created_at&order=created_at.desc',
  )

  /**
   * Every request's real state, in one pass.
   *
   * The sidebar used to show a name and the word "new" — which told you nothing about
   * whether a request had been built, was building, half-saved, or approved. Someone
   * opening this page wants to know what is up to date, and that answer lives in the
   * database, not in the request row.
   *
   * Read as three lists and joined here rather than as a query per request: a customer
   * with thirty requests would otherwise open ninety connections to render a sidebar.
   */
  const allRevisions = requests.length
    ? await read<{ id: string; request_id: string; n: number; status: string; approved_at: string | null }[]>(
        token,
        `revisions?request_id=in.(${requests.map((r) => r.id).join(',')})&select=id,request_id,n,status,approved_at&order=n.desc`,
      )
    : []
  const allRuns = allRevisions.length
    ? await read<
        { revision_id: string; status: string; exit_reason: string | null; sandbox_id: string | null }[]
      >(
        token,
        `runs?revision_id=in.(${allRevisions.map((r) => r.id).join(',')})` +
          '&select=revision_id,status,exit_reason,sandbox_id&order=started_at.desc',
      )
    : []
  const allArtifacts = allRevisions.length
    ? await read<{ revision_id: string; role: string }[]>(
        token,
        `artifacts?revision_id=in.(${allRevisions.map((r) => r.id).join(',')})&select=revision_id,role`,
      )
    : []

  const summaries = requests.map((request) => {
    const mine = allRevisions.filter((r) => r.request_id === request.id)
    const latest = mine[0] ?? null
    const run = latest ? (allRuns.find((r) => r.revision_id === latest.id) ?? null) : null
    const renders = latest
      ? allArtifacts.filter((a) => a.revision_id === latest.id && a.role === 'render').length
      : 0
    return {
      id: request.id,
      name: request.campaign_name,
      kind: request.kind,
      revisions: mine.length,
      latestN: latest?.n ?? null,
      // `draft` with no run means nothing ever started — which is a different problem
      // from a run that failed, and the sidebar has to distinguish them.
      state: !latest
        ? 'no revision'
        : latest.approved_at
          ? 'approved'
          : latest.status === 'draft' && !run
            ? 'not started'
            : run && ['starting', 'running'].includes(run.status) && run.sandbox_id
              ? 'running'
              : run && ['starting', 'running'].includes(run.status)
                // Claims to be starting with no box behind it. Named, not shown as
                // running, because a request that never launched is not in progress.
                ? 'never started'
                : latest.status,
      renders,
      exitReason: run?.exit_reason ?? null,
    }
  })

  if (requests.length === 0) {
    return (
      <ReviewClient
        customerId={customerId}
        requests={[]}
        selected={null}
        runActive={false}
        devLogs={env().CQ_DEV_LOGS === '1'}
      />
    )
  }

  const requestId = params.request && requests.some((r) => r.id === params.request)
    ? params.request
    : requests[0].id
  const request = requests.find((r) => r.id === requestId) as RequestRow

  // Latest revision first: the thing under review is almost always the newest one.
  const revisions = await read<Revision[]>(
    token,
    `revisions?request_id=eq.${requestId}&select=id,n,status,request_id,created_at,approved_at&order=n.desc`,
  )
  const revision = revisions[0] ?? null

  const canvases = await read<Canvas[]>(
    token,
    `request_canvases?request_id=eq.${requestId}&select=name,width,height,producible,refusal&order=name`,
  )

  const artifacts = revision
    ? await read<Artifact[]>(
        token,
        `artifacts?revision_id=eq.${revision.id}&select=id,relative_path,storage_key,role,canvas_name,bytes&order=relative_path`,
      )
    : []

  const threads = await read<Thread[]>(
    token,
    `comment_threads?request_id=eq.${requestId}&select=id,canvas_name,region_x,region_y,region_w,region_h,status,opened_on_revision,created_at&order=created_at`,
  )
  const messages = threads.length
    ? await read<Message[]>(
        token,
        `comment_messages?thread_id=in.(${threads.map((t) => t.id).join(',')})&select=id,thread_id,author,body,instruction,created_at&order=created_at`,
      )
    : []

  const findings = revision
    ? await read<Finding[]>(
        token,
        `findings?revision_id=eq.${revision.id}&select=code,severity,detail,revision_id`,
      )
    : []

  // Sign every render once, here, rather than on demand in the client. Twenty
  // minutes is the same budget the run token and the sandbox timeout use.
  const renders = artifacts.filter((a) => a.role === 'render')
  const urls: Record<string, string> = {}
  for (const artifact of renders) {
    const url = await sign(token, artifact.storage_key)
    if (url && artifact.canvas_name) urls[artifact.canvas_name] = url
  }

  const producible = canvases.filter((c) => c.producible)
  const canvasName =
    params.canvas && producible.some((c) => c.name === params.canvas)
      ? params.canvas
      : (renders[0]?.canvas_name ?? producible[0]?.name ?? null)

  /**
   * Whether a run is going right now, decided from the database.
   *
   * The progress panel used to appear only if *this browser tab* had pressed the button.
   * Refresh, or start a run from anywhere else, and the screen showed a finished-looking
   * request with no indication that a sandbox was mid-render — which is exactly when
   * someone most wants to see it.
   */
  /**
   * A run counts as active only once a sandbox actually exists.
   *
   * `status` alone was not enough. The launcher inserts the run row before it validates
   * hydration and long before it creates a box, so a launch that refuses early — a kit
   * with no fonts, a stale template — leaves a row reading `starting` with
   * `sandbox_id` null and nothing behind it. This screen then said "Working in a
   * sandbox" indefinitely for a sandbox that was never created.
   *
   * `sandbox_id` is written at the moment the box exists, which makes it the honest
   * signal: a row can claim to be starting, but it cannot claim an id it was never
   * given. Six such rows had accumulated before this was noticed.
   *
   * A stale row is now also reported rather than ignored, because "this run failed
   * before it began" is information, and silence here is what let those six sit
   * unnoticed.
   */
  const runRows = revision
    ? await read<{ status: string; sandbox_id: string | null; started_at: string }[]>(
        token,
        `runs?revision_id=eq.${revision.id}&status=in.(starting,running)` +
          '&select=status,sandbox_id,started_at&order=started_at.desc&limit=1',
      )
    : []

  const activeRun = runRows.some((r) => Boolean(r.sandbox_id))
  const phantomRun = runRows.length > 0 && !activeRun

  /**
   * What it takes to deploy this revision, read before the screen renders.
   *
   * Two things are needed and neither can be invented. `deployment` is any existing
   * deployment for this revision, so "Deploy now" runs that one instead of making a
   * second. `template` is the campaign, objective and tool fields from the kit's most
   * recent deployment — the agent stops on an empty required field, so without a
   * previous deployment to copy there is nothing honest for a one-click button to
   * send, and the UI says so rather than starting a run that will stop.
   */
  const kitDeployments = await read<
    {
      id: string
      name: string
      status: string
      target_campaign: string | null
      target_objective: string | null
      target_fields: Record<string, string> | null
      verified_url: string | null
      recording_artifact_id: string | null
      created_at: string
    }[]
  >(
    token,
    `deployments?kit_id=eq.${encodeURIComponent(request.kit_id)}` +
      '&select=id,name,status,target_campaign,target_objective,target_fields,verified_url,' +
      'recording_artifact_id,created_at&order=created_at.desc',
  )

  const deployItems = kitDeployments.length
    ? await read<{ deployment_id: string; revision_id: string; canvas_name: string | null }[]>(
        token,
        `deployment_items?deployment_id=in.(${kitDeployments.map((d) => d.id).join(',')})` +
          '&select=deployment_id,revision_id,canvas_name',
      )
    : []

  const mine = deployItems.filter((i) => i.revision_id === revision.id)
  const existing = kitDeployments.find((d) => mine.some((i) => i.deployment_id === d.id)) ?? null

  const deployRuns = existing
    ? await read<{ deployment_id: string; status: string; exit_reason: string | null }[]>(
        token,
        `deploy_runs?deployment_id=eq.${existing.id}` +
          '&select=deployment_id,status,exit_reason&order=started_at.desc&limit=1',
      )
    : []

  // The newest deployment that actually carried settings, whichever revision it was for.
  const source = kitDeployments.find((d) => d.target_campaign) ?? null

  return (
    <ReviewClient
      customerId={customerId}
      devLogs={env().CQ_DEV_LOGS === '1'}
      runActive={activeRun}
      phantomRun={phantomRun}
      requests={summaries}
      deploy={{
        existing: existing
          ? {
              id: existing.id,
              name: existing.name,
              status: existing.status,
              verifiedUrl: existing.verified_url,
              recorded: Boolean(existing.recording_artifact_id),
              canvasName: mine[0]?.canvas_name ?? null,
              runStatus: deployRuns[0]?.status ?? null,
            }
          : null,
        template: source
          ? {
              campaign: source.target_campaign,
              objective: source.target_objective,
              fields: source.target_fields ?? {},
              from: source.name,
            }
          : null,
      }}
      selected={{
        request,
        revisions,
        revision,
        canvases,
        canvasName,
        artifacts,
        urls,
        threads,
        messages,
        findings,
      }}
    />
  )
}

export const dynamic = 'force-dynamic'
