import { redirect } from 'next/navigation'
import { read, session, sign } from '@/lib/read'
import { env } from '@/lib/server'
import DeployClient from './deploy-client'

/**
 * Screen 3: the deployment plan.
 *
 * Deploying is the one action that reaches outside this system, so the table is built
 * around evidence rather than intent: every row shows whether a recording exists and
 * whether a url was read back off the tool's own page. A deploy with neither is
 * reported as unverified however confidently it finished.
 */
export default async function DeployPage() {
  const current = await session()
  if (!current) redirect('/')
  const { token, customerId } = current

  const deployments = await read<
    {
      id: string
      name: string
      kit_id: string
      status: string
      target_tool: string
      target_url: string
      target_campaign: string | null
      target_objective: string | null
      target_fields: Record<string, string> | null
      verified_url: string | null
      verified_note: string | null
      recording_artifact_id: string | null
      created_at: string
    }[]
  >(token, 'deployments?select=*&order=created_at.desc')

  const items = deployments.length
    ? await read<{ deployment_id: string; revision_id: string; canvas_name: string | null }[]>(
        token,
        `deployment_items?deployment_id=in.(${deployments.map((d) => d.id).join(',')})&select=deployment_id,revision_id,canvas_name`,
      )
    : []

  const runs = deployments.length
    ? await read<{ deployment_id: string; status: string; exit_reason: string | null; started_at: string }[]>(
        token,
        `deploy_runs?deployment_id=in.(${deployments.map((d) => d.id).join(',')})&select=deployment_id,status,exit_reason,started_at&order=started_at.desc`,
      )
    : []

  // Only approved revisions can be deployed, so only approved revisions are offered.
  const approved = await read<
    { id: string; n: number; request_id: string; approved_at: string }[]
  >(token, 'revisions?approved_at=not.is.null&select=id,n,request_id,approved_at&order=approved_at.desc')

  const requests = approved.length
    ? await read<{ id: string; campaign_name: string; kit_id: string }[]>(
        token,
        `requests?id=in.(${[...new Set(approved.map((r) => r.request_id))].join(',')})&select=id,campaign_name,kit_id`,
      )
    : []

  const recordings = await read<
    {
      id: string
      relative_path: string
      bytes: number | null
      storage_key: string
      revision_id: string
      run_id: string | null
      created_at: string
    }[]
  >(
    token,
    'artifacts?role=eq.recording&select=id,relative_path,bytes,storage_key,revision_id,run_id,created_at',
  )

  /**
   * A signed url per recording, so a deploy can actually be watched.
   *
   * "No recording, no deploy" is only half a rule while the recording cannot be
   * played back — evidence nobody can look at is indistinguishable from no evidence.
   * The bucket is private, so a signed url is the only way to show one, and it is
   * signed with the session token: policy decides whether the row is visible at all,
   * and the signature is downstream of that rather than a way around it.
   *
   * An hour is long enough to watch a two-minute video and short enough that a url
   * pasted elsewhere stops working.
   */
  const recordingUrls = new Map<string, string>()
  for (const recording of recordings) {
    const url = await sign(token, recording.storage_key, 3600)
    if (url) recordingUrls.set(recording.id, url)
  }

  /**
   * Every recording this customer owns, labelled by campaign rather than by
   * deployment.
   *
   * Keyed on the campaign because that is the label that always resolves. A
   * recording references a revision, and a revision always belongs to a campaign —
   * whereas the deployment it ran for can be deleted, and two of these already have
   * been. Attributing by deployment name would have left those recordings unlabelled
   * on screen, which for a file whose whole purpose is evidence is the one outcome
   * worth designing against.
   *
   * The deployment name and outcome are still attached where the run survives, since
   * they are what someone is usually looking for.
   */
  const allDeployRuns = await read<
    { id: string; run_id: string | null; deployment_id: string; status: string }[]
  >(token, 'deploy_runs?select=id,run_id,deployment_id,status')

  const recordingRevisionIds = [...new Set(recordings.map((r) => r.revision_id))]
  const recordingRevisions = recordingRevisionIds.length
    ? await read<{ id: string; n: number; request_id: string }[]>(
        token,
        `revisions?id=in.(${recordingRevisionIds.join(',')})&select=id,n,request_id`,
      )
    : []
  const recordingRequests = recordingRevisions.length
    ? await read<{ id: string; campaign_name: string }[]>(
        token,
        `requests?id=in.(${[...new Set(recordingRevisions.map((r) => r.request_id))].join(',')})` +
          '&select=id,campaign_name',
      )
    : []

  const sessions = recordings
    .map((recording) => {
      const deployRun = allDeployRuns.find((r) => r.run_id === recording.run_id) ?? null
      const deployment = deployRun
        ? (deployments.find((d) => d.id === deployRun.deployment_id) ?? null)
        : null
      const revision = recordingRevisions.find((r) => r.id === recording.revision_id) ?? null
      const request = revision
        ? (recordingRequests.find((q) => q.id === revision.request_id) ?? null)
        : null
      return {
        id: recording.id,
        url: recordingUrls.get(recording.id) ?? null,
        bytes: recording.bytes,
        recordedAt: recording.created_at,
        campaign: request?.campaign_name ?? 'unknown campaign',
        revisionN: revision?.n ?? null,
        deploymentName: deployment?.name ?? null,
        outcome: deployment?.status ?? deployRun?.status ?? null,
        verifiedUrl: deployment?.verified_url ?? null,
      }
    })
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))

  /**
   * The canvases each approved revision actually rendered.
   *
   * Read from the artifacts rather than from the request's canvas specs, because a
   * partially-saved run has fewer renders than it planned — and offering a canvas
   * that was never produced would send the agent looking for a file that is not
   * there.
   */
  const renders = await read<{ revision_id: string; canvas_name: string | null }[]>(
    token,
    'artifacts?role=eq.render&select=revision_id,canvas_name',
  )

  return (
    <DeployClient
      customerId={customerId}
      devLogs={env().CQ_DEV_LOGS === '1'}
      sessions={sessions}
      deployments={deployments.map((d) => ({
        ...d,
        itemCount: items.filter((i) => i.deployment_id === d.id).length,
        lastRun: runs.find((r) => r.deployment_id === d.id) ?? null,
        recording: (() => {
          const found = recordings.find((r) => r.id === d.recording_artifact_id)
          return found ? { ...found, url: recordingUrls.get(found.id) ?? null } : null
        })(),
      }))}
      approved={approved.map((r) => {
        const request = requests.find((q) => q.id === r.request_id)
        return {
          revisionId: r.id,
          n: r.n,
          kitId: request?.kit_id ?? '',
          campaign: request?.campaign_name ?? 'unknown',
          canvases: [
            ...new Set(
              renders
                .filter((a) => a.revision_id === r.id && a.canvas_name)
                .map((a) => a.canvas_name as string),
            ),
          ],
        }
      })}
    />
  )
}

export const dynamic = 'force-dynamic'
