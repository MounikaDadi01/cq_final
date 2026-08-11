'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ADSTREAM } from '@/lib/adstream-options'

interface Deployment {
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
  itemCount: number
  lastRun: { status: string; exit_reason: string | null; started_at: string } | null
  recording: {
    id: string
    relative_path: string
    bytes: number | null
    /** Signed on the server, because the bucket is private. Null if signing failed. */
    url: string | null
  } | null
}

interface Props {
  customerId: string
  deployments: Deployment[]
  approved: { revisionId: string; n: number; kitId: string; campaign: string; canvases: string[] }[]
  devLogs: boolean
  /** Every recording this customer owns, newest first. */
  sessions: {
    id: string
    url: string | null
    bytes: number | null
    recordedAt: string
    campaign: string
    revisionN: number | null
    deploymentName: string | null
    outcome: string | null
    verifiedUrl: string | null
  }[]
}

/**
 * A recording's timestamp, in the reader's own timezone.
 *
 * Stored in UTC and rendered locally, because "was this the run I watched fail an
 * hour ago" is the actual question being asked of it, and that is unanswerable
 * against a UTC string when you are not on UTC.
 */
function when(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

interface DeployProgress {
  status: string
  recorded: boolean
  verifiedUrl: string | null
  verifiedNote: string | null
  run: { status: string; exit_reason: string | null } | null
}

/**
 * The stages a deploy passes through, in the order they become true.
 *
 * Deliberately few, and every one of them backed by a row rather than by elapsed
 * time. A deploy spends most of its life with the agent reading a page and
 * clicking, which produces nothing observable from here — so the choice is between
 * naming the handful of moments that do land in the database and inventing a
 * smooth bar that implies knowledge we do not have. Four honest dots beat a
 * convincing animation.
 */
function stagesOf(progress: DeployProgress | null): { label: string; done: boolean }[] {
  const run = progress?.run
  return [
    { label: 'box started', done: Boolean(run) },
    {
      label: 'driving the tool',
      done: Boolean(run && (run.status === 'running' || run.status === 'completed')),
    },
    { label: 'recording saved', done: Boolean(progress?.recorded) },
    { label: 'url read back', done: Boolean(progress?.verifiedUrl) },
  ]
}

/** Status colour follows evidence, not optimism. */
function chipFor(status: string) {
  if (status === 'published') return 'ok'
  if (status === 'unverified') return 'warn'
  if (status === 'stopped' || status === 'failed') return 'stop'
  return 'neutral'
}

export default function DeployClient({
  customerId,
  deployments,
  approved,
  devLogs,
  sessions,
}: Props) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // Seeded from the server so a mid-deploy refresh keeps watching.
  const [watching, setWatching] = useState<string | null>(
    deployments.find((d) => d.lastRun && ['starting', 'running'].includes(d.lastRun.status))?.id ??
      null,
  )
  const [progress, setProgress] = useState<DeployProgress | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // Which recording is open, keyed by deployment id on a row or artifact id in the
  // session list. One at a time, so the page does not become a wall of near-identical
  // video with no way to tell which is playing.
  const [watchFor, setWatchFor] = useState<string | null>(null)
  // Which deployment's log is open, and its text. One at a time: two open logs of
  // near-identical output invite reading the wrong one.
  const [logFor, setLogFor] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [revisionId, setRevisionId] = useState(approved[0]?.revisionId ?? '')
  /**
   * Empty means every canvas on the revision, and that is the default.
   *
   * It used to default to one, because the tool's creative step takes a single image
   * and sending three made the agent stop. The right answer was not fewer canvases —
   * it was one ad per canvas, which the agent now does. A campaign's sizes are all
   * meant to ship, so shipping one by default was quietly dropping two.
   */
  const [canvas, setCanvas] = useState('')
  // Defaults are the tool's first option rather than blank: every one of these is
  // required on Adstream's form, and a blank stops the deploy at that step.
  const [campaign, setCampaign] = useState<string>(ADSTREAM.campaigns[0])
  const [objective, setObjective] = useState<string>(ADSTREAM.objectives[0])
  const [adName, setAdName] = useState('')
  const [audience, setAudience] = useState<string>(ADSTREAM.audiences[0])
  const [placements, setPlacements] = useState<string[]>([ADSTREAM.placements[0]])
  const [budget, setBudget] = useState('50')
  const [ctaChoice, setCtaChoice] = useState<string>(ADSTREAM.ctas[0])
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy('create')
    setError(null)
    /**
     * Keys are the tool's own field labels, because that is what the agent matches
     * against on the page. Placements is joined with a comma since the tool takes
     * several and the agent ticks each one it finds.
     */
    const parsed: Record<string, string> = {
      'Ad name': adName.trim() || name.trim(),
      Audience: audience,
      Placements: placements.join(', '),
      'Daily budget': budget.trim(),
      'Call to action': ctaChoice,
    }
    if (!placements.length) {
      setError('choose at least one placement — the tool requires one')
      setBusy(null)
      return
    }
    if (!/^\d+(\.\d+)?$/.test(budget.trim())) {
      setError('daily budget must be a number')
      setBusy(null)
      return
    }
    const response = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        revision_id: revisionId,
        canvas_name: canvas || null,
        target_campaign: campaign.trim() || null,
        target_objective: objective.trim() || null,
        target_fields: parsed,
      }),
    })
    setBusy(null)
    if (!response.ok) {
      const { error: message } = (await response.json()) as { error?: string }
      setError(message ?? 'could not create the deployment')
      return
    }
    setCreating(false)
    setName('')
    setToast('Deployment created — run it when the fields are right')
    router.refresh()
  }

  async function run(id: string) {
    setBusy(id)
    const response = await fetch('/api/deploy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deployment_id: id }),
    })
    setBusy(null)
    if (!response.ok) {
      const { error: message } = (await response.json()) as { error?: string }
      setToast(`Could not start — ${message}`)
      return
    }
    // Watch from the moment it starts, rather than waiting for a refresh to notice.
    setWatching(id)
    setElapsed(0)
    setProgress(null)
    setToast('Deploying — the box drives the tool and records what it does')
    router.refresh()
  }

  /**
   * Live progress while a deploy is in a box.
   *
   * Seeded from the server on load as well as set by `run`, so a refresh in the
   * middle of a deploy keeps showing progress instead of looking idle — the same
   * reason the render screen seeds from the database.
   */
  useEffect(() => {
    if (!watching) return
    let cancelled = false
    const started = Date.now()

    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`/api/status?deployment=${watching}`, { cache: 'no-store' })
        if (!response.ok || cancelled) return
        const body = (await response.json()) as { deployment: DeployProgress | null }
        if (!body.deployment || cancelled) return
        setProgress(body.deployment)

        // Terminal states only. `planned` means the launcher has not written
        // anything yet, and treating that as finished would stop the watch before
        // the deploy had begun.
        if (['published', 'unverified', 'stopped', 'failed'].includes(body.deployment.status)) {
          setWatching(null)
          router.refresh()
        }
      } catch {
        /* a failed poll is not a failed deploy; the next tick tries again */
      }
    }, 2500)

    // A deploy that outlives this says so rather than spinning forever.
    const giveUp = setTimeout(() => {
      if (cancelled) return
      setWatching(null)
      setToast('Still deploying after 6 minutes — check the run row, or the developer log')
    }, 360_000)

    return () => {
      cancelled = true
      clearInterval(tick)
      clearInterval(poll)
      clearTimeout(giveUp)
    }
  }, [watching, router])

  async function loadLog(id: string) {
    if (logFor === id) {
      setLogFor(null)
      setLog(null)
      return
    }
    setLogFor(id)
    setLog('loading…')
    const response = await fetch(`/api/logs?deployment=${id}`, { cache: 'no-store' })
    const body = (await response.json()) as { log?: string; note?: string; error?: string }
    setLog(body.error ?? body.log ?? body.note ?? '(empty)')
  }

  return (
    <>
      <div className="titlebar">
        <a className="brandmark" href="/review">character.quilt</a>
        <span>Deploy</span>
        <span className="right">
          <span className="chip blue">{customerId}</span>
          <a className="btn sm" href="/review">Agent work</a>
          <a className="btn sm" href="/brand">Brand</a>
        </span>
      </div>

      <div className="page">
        <div className="page-head">
          <div>
            <div className="h">Deployment plan</div>
            <div className="s">
              Only approved revisions can ship. A deploy is <b>published</b> only with a
              recording and a url read back off the tool&apos;s own page — anything else is
              unverified, however confidently it finished.
            </div>
          </div>
          <span className="right">
            <button className="btn dark" onClick={() => setCreating(true)} disabled={approved.length === 0}>
              ＋ New deployment
            </button>
          </span>
        </div>

        {approved.length === 0 && (
          <div className="banner">
            <span>
              Nothing is approved yet. Approve a complete revision in Review and it becomes
              available here.
            </span>
            <span className="right"><a className="btn sm" href="/review">Go to review</a></span>
          </div>
        )}

        <div className="panel">
          <div className="trow head" style={{ gridTemplateColumns: '2fr 60px 1.1fr 1.6fr 150px' }}>
            <span>Deployment</span><span>Assets</span><span>Target</span><span>Evidence</span>
            <span style={{ textAlign: 'right' }}>Actions</span>
          </div>
          {deployments.map((d) => (
            <div key={d.id}>
            <div className="trow" style={{ gridTemplateColumns: '2fr 60px 1.1fr 1.6fr 150px' }}>
              <div>
                <div style={{ fontWeight: 560 }}>{d.name}</div>
                <div className="dim">
                  {d.lastRun
                    ? `last run ${d.lastRun.status}${d.lastRun.exit_reason ? ` · ${d.lastRun.exit_reason}` : ''}`
                    : 'never run'}
                </div>
              </div>
              <span className="mono">{d.itemCount}</span>
              <div>
                <span className="pill">{d.target_tool}</span>
                <div className="dim">{d.target_campaign ?? 'no campaign chosen'}</div>
              </div>
              <div>
                <span className={`chip ${chipFor(d.status)}`}>{d.status}</span>
                <div className="dim">
                  {d.verified_url ? (
                    <a href={d.verified_url} target="_blank" rel="noreferrer" style={{ color: 'var(--blue)' }}>
                      {d.verified_url.replace(/^https?:\/\/[^/]+/, '')}
                    </a>
                  ) : (
                    (d.verified_note ?? 'no url read back')
                  )}
                </div>
                <div className="dim">
                  {d.recording ? (
                    d.recording.url ? (
                      <button
                        className="linkish"
                        onClick={() => setWatchFor(watchFor === d.id ? null : d.id)}
                      >
                        {watchFor === d.id ? 'Hide recording' : 'Watch recording'} ·{' '}
                        {Math.round((d.recording.bytes ?? 0) / 1024)} KB
                      </button>
                    ) : (
                      // The row exists but the url did not sign. Said plainly, because
                      // "no recording" here would be a different and worse fact.
                      `recording saved, could not be signed for playback`
                    )
                  ) : (
                    'no recording'
                  )}
                </div>
              </div>
              <div className="acts">
                <button
                  className="btn sm"
                  disabled={busy !== null || watching === d.id}
                  onClick={() => run(d.id)}
                >
                  {busy === d.id
                    ? 'Starting…'
                    : watching === d.id
                      ? 'Deploying…'
                      : d.status === 'planned'
                        ? 'Deploy'
                        : 'Restart deploy'}
                </button>
                {devLogs && (
                  <button className="btn sm ghost" onClick={() => loadLog(d.id)}>
                    {logFor === d.id ? 'Hide log' : 'Developer logs'}
                  </button>
                )}
              </div>
            </div>

            {watching === d.id && (
              <div className="running">
                <div className="running-head">
                  <span className="beat" />
                  <b>Driving {d.target_tool} in a sandbox</b>
                  <span className="mono">{elapsed}s</span>
                  <span className="right mono">typically 90–180s</span>
                </div>
                <div className="meter">
                  <span
                    style={{
                      width: `${Math.min(
                        95,
                        Math.max(
                          // Elapsed is the floor, not the measure: it keeps the bar from
                          // sitting at zero while the box boots, and every real advance
                          // past that comes from a stage actually completing.
                          Math.min(35, elapsed),
                          (stagesOf(progress).filter((s) => s.done).length / 4) * 100,
                        ),
                      )}%`,
                    }}
                  />
                </div>
                <div className="running-steps">
                  {stagesOf(progress).map((stage) => (
                    <span key={stage.label} className={stage.done ? 'on' : ''}>
                      {stage.label}
                    </span>
                  ))}
                  <span className="right">{progress?.run?.status ?? 'starting'}</span>
                </div>
                <div className="running-note">
                  A deploy is <b>published</b> only once a recording exists and a url has been
                  read back off {d.target_tool}&apos;s own page. Until both are true this stays
                  unverified, however far the bar has moved.
                </div>
              </div>
            )}

            {watchFor === d.id && d.recording?.url && (
              <div className="devlog">
                <div className="running-head">
                  <b>What the agent did</b>
                  <span className="right mono">{d.recording.relative_path.split('/').pop()}</span>
                </div>
                {/*
                  The whole session, start to finish, at the size it was recorded.
                  Not muted-and-autoplaying: this is evidence someone chose to inspect,
                  so it waits to be played and keeps its controls.
                */}
                <video
                  controls
                  preload="metadata"
                  src={d.recording.url}
                  style={{ width: '100%', borderRadius: 6, background: '#000' }}
                />
                <div className="dim" style={{ marginTop: 6 }}>
                  Recorded inside the sandbox by Playwright and flushed when the browser
                  context closed. A deploy with no recording is never marked published.
                  {d.verified_url ? ' The url below was read back off the tool’s own page.' : ''}
                </div>
              </div>
            )}

            {logFor === d.id && (
              <div className="devlog">
                <div className="running-head">
                  <b>Developer log</b>
                  <span className="right mono">deploy-{d.id.slice(0, 8)}.log</span>
                </div>
                <pre>{log}</pre>
              </div>
            )}
            </div>
          ))}
          {deployments.length === 0 && (
            <div className="arow"><div className="dim">No deployments yet.</div></div>
          )}
        </div>

        {/*
          Every recording, not only the latest.
          A deployment row points at one recording, so a deployment run twice keeps
          only the newest on the row while the earlier video stays in storage. This
          panel is the list that does not lose them — and it survives the deployment
          being deleted, because it is built from the artifacts themselves.
        */}
        <div className="panel">
          <div className="trow head" style={{ gridTemplateColumns: '1.5fr 1.4fr 110px 90px 130px' }}>
            <span>Campaign</span><span>Deployment</span><span>Recorded</span><span>Size</span>
            <span style={{ textAlign: 'right' }}>Session</span>
          </div>
          {sessions.map((s) => (
            <div key={s.id}>
              <div className="trow" style={{ gridTemplateColumns: '1.5fr 1.4fr 110px 90px 130px' }}>
                <div>
                  <div style={{ fontWeight: 560 }}>{s.campaign}</div>
                  <div className="dim">{s.revisionN ? `rev ${s.revisionN}` : 'revision unknown'}</div>
                </div>
                <div>
                  {/* A deleted deployment leaves its recording behind. Said plainly. */}
                  <div>{s.deploymentName ?? <span className="dim">deployment deleted</span>}</div>
                  {s.outcome && <span className={`chip ${chipFor(s.outcome)}`}>{s.outcome}</span>}
                </div>
                <span className="mono dim">{when(s.recordedAt)}</span>
                <span className="mono dim">{Math.round((s.bytes ?? 0) / 1024)} KB</span>
                <div className="acts">
                  {s.url ? (
                    <button
                      className="btn sm"
                      onClick={() => setWatchFor(watchFor === s.id ? null : s.id)}
                    >
                      {watchFor === s.id ? 'Hide' : 'Watch'}
                    </button>
                  ) : (
                    <span className="dim">could not sign</span>
                  )}
                </div>
              </div>
              {watchFor === s.id && s.url && (
                <div className="devlog">
                  <div className="running-head">
                    <b>{s.campaign}</b>
                    <span className="right mono">{when(s.recordedAt)}</span>
                  </div>
                  <video
                    controls
                    preload="metadata"
                    src={s.url}
                    style={{ width: '100%', borderRadius: 6, background: '#000' }}
                  />
                  {s.verifiedUrl && (
                    <div className="dim" style={{ marginTop: 6 }}>
                      Published to{' '}
                      <a href={s.verifiedUrl} target="_blank" rel="noreferrer">
                        {s.verifiedUrl.replace(/^https?:\/\/[^/]+/, '')}
                      </a>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {sessions.length === 0 && (
            <div className="arow">
              <div className="dim">
                No session recordings yet. Every deploy records the browser, and a deploy
                with no recording is never marked published.
              </div>
            </div>
          )}
        </div>

        <div className="banner info">
          <span>
            The tool&apos;s own fields — campaign, objective, audience, placement, budget, call
            to action — come from a person, not the agent. It stops rather than inventing
            one, because a guessed campaign attaches an ad to the wrong budget.
          </span>
        </div>
      </div>

      {creating && (
        <div className="scrim" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
            <div className="h">
              New deployment
              <button onClick={() => setCreating(false)}>✕</button>
            </div>
            <div className="s">Choose an approved revision and give the tool what it needs.</div>

            <input className="composer-input" placeholder="Deployment name" value={name} onChange={(e) => setName(e.target.value)} />
            <select
              className="composer-input"
              value={revisionId}
              onChange={(e) => {
                setRevisionId(e.target.value)
                // Canvas names belong to the revision, so a stale one would name a
                // file the new revision never rendered. Re-default rather than clear.
                setCanvas('')
              }}
            >
              {approved.map((r) => (
                <option key={r.revisionId} value={r.revisionId}>
                  {r.campaign} · rev {r.n}
                </option>
              ))}
            </select>

            {/*
              One canvas per deployment, because Adstream's creative step offers a
              single image upload. Sending all three made the agent stop — correctly,
              since choosing which of a customer's ads goes live is not its call.
            */}
            <select
              className="composer-input"
              value={canvas}
              onChange={(e) => setCanvas(e.target.value)}
            >
              <option value="">every canvas on this revision</option>
              {(approved.find((r) => r.revisionId === revisionId)?.canvases ?? []).map((c) => (
                <option key={c} value={c}>
                  only {c}
                </option>
              ))}
            </select>
            <div className="dim">
              {canvas
                ? `Publishes ${canvas} alone. The other sizes on this revision stay unpublished.`
                : `Publishes one ad per canvas — ${
                    (approved.find((r) => r.revisionId === revisionId)?.canvases ?? []).length
                  } ad(s), same campaign and settings, distinguished by size. The deploy is only
                   marked published once every one is confirmed in the tool's list.`}
            </div>
            {/*
              Picked from the tool's own option sets, not typed. A campaign that does not
              exist on Adstream stops the deploy at its first step, so free text here was
              a way to waste a sandbox on a typo.
            */}
            <div style={{ display: 'flex', gap: 7 }}>
              <select className="composer-input" value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                {ADSTREAM.campaigns.map((c) => (
                  <option key={c} value={c}>Campaign · {c}</option>
                ))}
              </select>
              <select className="composer-input" value={objective} onChange={(e) => setObjective(e.target.value)}>
                {ADSTREAM.objectives.map((o) => (
                  <option key={o} value={o}>Objective · {o}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="dim" style={{ marginBottom: 4 }}>
                Everything else the tool&apos;s form asks for, using its own options.
              </div>
              <input
                className="composer-input"
                placeholder="Ad name as it appears in the tool"
                value={adName}
                onChange={(e) => setAdName(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 7 }}>
                <select className="composer-input" value={audience} onChange={(e) => setAudience(e.target.value)}>
                  {ADSTREAM.audiences.map((a) => (
                    <option key={a} value={a}>Audience · {a}</option>
                  ))}
                </select>
                <select className="composer-input" value={ctaChoice} onChange={(e) => setCtaChoice(e.target.value)}>
                  {ADSTREAM.ctas.map((c) => (
                    <option key={c} value={c}>CTA · {c}</option>
                  ))}
                </select>
              </div>
              {/* Checkboxes on the tool, so several are allowed here too. */}
              <div className="row wrap">
                {ADSTREAM.placements.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`pill ${placements.includes(p) ? 'on' : ''}`}
                    onClick={() =>
                      setPlacements((prior) =>
                        prior.includes(p) ? prior.filter((x) => x !== p) : [...prior, p],
                      )
                    }
                  >
                    {p}
                  </button>
                ))}
                <input
                  className="composer-input"
                  style={{ maxWidth: 130 }}
                  placeholder="Daily budget"
                  inputMode="decimal"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
              </div>
            </div>

            {error && <span className="chip stop">{error}</span>}
            <div className="foot">
              <button className="btn" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn primary" disabled={!name.trim() || !revisionId || busy !== null} onClick={create}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast">
          {toast}
          <button onClick={() => setToast(null)}>Dismiss</button>
        </div>
      )}
    </>
  )
}
