'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Artifact, Canvas, Finding, Message, RequestRow, Revision, Thread } from '@/lib/read'

interface Selected {
  request: RequestRow
  revisions: Revision[]
  revision: Revision | null
  canvases: Canvas[]
  canvasName: string | null
  artifacts: Artifact[]
  urls: Record<string, string>
  threads: Thread[]
  messages: Message[]
  findings: Finding[]
}

/** Everything the sidebar needs to say what state a request is in. */
interface RequestSummary {
  id: string
  name: string
  kind: string
  revisions: number
  latestN: number | null
  state: string
  renders: number
  exitReason: string | null
}

interface Props {
  customerId: string
  requests: RequestSummary[]
  selected: Selected | null
  /** True when a run is already in flight, read from the database rather than local state. */
  runActive: boolean
  /**
   * A run row that says it is starting but never got a sandbox.
   *
   * Surfaced instead of hidden: the request looks idle otherwise, and "the launcher
   * refused before starting a box" is the one thing that explains why.
   */
  phantomRun?: boolean
  deploy?: {
    existing: {
      id: string
      name: string
      status: string
      verifiedUrl: string | null
      recorded: boolean
      canvasName: string | null
      runStatus: string | null
    } | null
    template: {
      campaign: string | null
      objective: string | null
      fields: Record<string, string>
      from: string
    } | null
  }
  devLogs: boolean
}

/** A rectangle in canvas fractions, which is how a region is stored. */
interface Region {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Deploy stages, named by the rows that make them true.
 *
 * Kept identical to the deploy screen's, so the same four words mean the same four
 * things wherever a deploy is watched. Two vocabularies for one process is how a
 * person ends up believing a deploy got further than it did.
 */
function deployStages(p: {
  recorded: boolean
  verifiedUrl: string | null
  runStatus: string | null
} | null): { label: string; done: boolean }[] {
  return [
    { label: 'box started', done: Boolean(p?.runStatus) },
    {
      label: 'driving the tool',
      done: p?.runStatus === 'running' || p?.runStatus === 'completed',
    },
    { label: 'recording saved', done: Boolean(p?.recorded) },
    { label: 'url read back', done: Boolean(p?.verifiedUrl) },
  ]
}

export default function ReviewClient({
  customerId,
  requests,
  selected,
  runActive,
  phantomRun,
  devLogs,
  deploy,
}: Props) {
  const router = useRouter()
  const artRef = useRef<HTMLDivElement | null>(null)

  const [mode, setMode] = useState<'pan' | 'comment'>('comment')
  const [drawing, setDrawing] = useState<Region | null>(null)
  const [pending, setPending] = useState<Region | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // Deploy state, seeded from the server so a refresh mid-deploy keeps watching.
  const [deployProgress, setDeployProgress] = useState(deploy?.existing ?? null)
  const [deployWatching, setDeployWatching] = useState(
    ['starting', 'running'].includes(deploy?.existing?.runStatus ?? '') ? deploy!.existing!.id : null,
  )
  const [deployElapsed, setDeployElapsed] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  /**
   * Live progress while a run is in a sandbox.
   *
   * A run takes over a minute. Without this the screen said "started" and then sat
   * there, which is indistinguishable from a dead box — so the honest thing is to show
   * what has actually landed: plates, then renders, then complete.
   */
  // Seeded from the database, so a refresh mid-render keeps showing progress.
  const [watching, setWatching] = useState(runActive)
  const [logOpen, setLogOpen] = useState(false)
  const [logText, setLogText] = useState('')
  const [progress, setProgress] = useState<{
    n: number
    status: string
    plates: number
    renders: number
    artifacts: number
    exit: string | null
  } | null>(null)
  const [elapsed, setElapsed] = useState(0)

  const producibleCount = selected?.canvases.filter((c) => c.producible).length ?? 0

  useEffect(() => {
    if (!watching || !selected) return
    const started = Date.now()
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)

    const poll = setInterval(async () => {
      try {
        const response = await fetch(`/api/status?request=${selected.request.id}`, { cache: 'no-store' })
        if (!response.ok) return
        const data = (await response.json()) as {
          latest: {
            n: number
            status: string
            plates: number
            renders: number
            artifacts: number
            run: { status: string; exit_reason: string | null } | null
          } | null
        }
        if (!data.latest) return
        setProgress({
          n: data.latest.n,
          status: data.latest.status,
          plates: data.latest.plates,
          renders: data.latest.renders,
          artifacts: data.latest.artifacts,
          exit: data.latest.run?.exit_reason ?? null,
        })

        // The RUN row decides when a run is over, not the revision's status.
        //
        // `save_work` sets the revision to `partial` before its first upload — it is a
        // "some work exists" marker during a normal save, not an outcome. Treating it
        // as terminal made the UI stop watching mid-save and show a stale, incomplete
        // revision as finished, which is exactly what it did.
        const runStatus = data.latest.run?.status
        if (runStatus && ['completed', 'failed', 'aborted'].includes(runStatus)) {
          setWatching(false)
          const partial = data.latest.status === 'partial'
          setToast(
            runStatus === 'completed' && !partial
              ? `Revision ${data.latest.n} is ready`
              : partial
                ? `Revision ${data.latest.n} saved partially — some canvases are missing`
                : `Revision ${data.latest.n} ${runStatus}`,
          )
          router.refresh()
        }
      } catch {
        /* a failed poll is not a failed run; the next tick tries again */
      }
    }, 2500)

    // A run that never reports is worse than a slow one, so the watch gives up rather
    // than spinning forever.
    const giveUp = setTimeout(() => {
      setWatching(false)
      setToast('Still running after 5 minutes — check back, or look at the run row')
    }, 300_000)

    return () => {
      clearInterval(tick)
      clearInterval(poll)
      clearTimeout(giveUp)
    }
  }, [watching, selected, router])

  const canvasName = selected?.canvasName ?? null
  const canvas = selected?.canvases.find((c) => c.name === canvasName) ?? null
  const url = canvasName ? selected?.urls[canvasName] : undefined

  const threadsHere = useMemo(
    () => (selected?.threads ?? []).filter((t) => !t.canvas_name || t.canvas_name === canvasName),
    [selected?.threads, canvasName],
  )
  const openCount = threadsHere.filter((t) => t.status === 'open').length

  const messagesFor = useCallback(
    (threadId: string) => (selected?.messages ?? []).filter((m) => m.thread_id === threadId),
    [selected?.messages],
  )

  /**
   * Turns a drag into a region in canvas fractions.
   *
   * Fractions rather than pixels because the same comment has to survive a re-render
   * at a different size, and mean the same thing on a square and a landscape.
   */
  const pointToFraction = (event: React.MouseEvent) => {
    const box = artRef.current?.getBoundingClientRect()
    if (!box) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
    }
  }

  const startDraw = (event: React.MouseEvent) => {
    if (mode !== 'comment') return
    const at = pointToFraction(event)
    if (!at) return
    setPending(null)
    setDrawing({ x: at.x, y: at.y, w: 0, h: 0 })
  }

  const moveDraw = (event: React.MouseEvent) => {
    if (!drawing) return
    const at = pointToFraction(event)
    if (!at) return
    setDrawing((d) =>
      d ? { x: Math.min(d.x, at.x), y: Math.min(d.y, at.y), w: Math.abs(at.x - d.x), h: Math.abs(at.y - d.y) } : d,
    )
  }

  const endDraw = () => {
    if (!drawing) return
    // A click, not a drag. Treated as a small square around the point rather than a
    // zero-size rectangle, because the reference allows "click item to comment" and a
    // zero-area region would fail the schema's own check.
    const region =
      drawing.w < 0.01 || drawing.h < 0.01
        ? { x: Math.max(0, drawing.x - 0.04), y: Math.max(0, drawing.y - 0.04), w: 0.08, h: 0.08 }
        : drawing
    setDrawing(null)
    setPending(region)
  }

  async function saveComment(thenRender: boolean) {
    if (!selected?.revision || !pending || !text.trim()) return
    setBusy(thenRender ? 'revise' : 'comment')
    const response = await fetch('/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: selected.request.id,
        revision_id: selected.revision.id,
        canvas_name: canvasName,
        region: pending,
        body: text.trim(),
      }),
    })
    if (!response.ok) {
      setToast(`Could not save the comment — ${await response.text()}`)
      setBusy(null)
      return
    }
    setPending(null)
    setText('')
    if (thenRender) {
      await startRun('revise')
    } else {
      setToast('Comment added')
      setBusy(null)
      router.refresh()
    }
  }

  async function startRun(runMode: 'rerender' | 'revise') {
    if (!selected?.revision) return
    setBusy(runMode)
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision_id: selected.revision.id, mode: runMode }),
    })
    setBusy(null)
    if (!response.ok) {
      setToast(`Could not start — ${await response.text()}`)
      return
    }
    setElapsed(0)
    setProgress(null)
    setWatching(true)
  }

  /**
   * Approval is its own column, not a status.
   *
   * A revision can be complete and unapproved; those are different facts. The
   * database also refuses to approve anything that is not complete, so a half-saved
   * run cannot become publishable.
   */
  async function approve() {
    if (!selected?.revision) return
    setBusy('approve')
    const response = await fetch('/api/comments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision_id: selected.revision.id, approve: true }),
    })
    setBusy(null)
    if (!response.ok) {
      setToast(`Could not approve — ${await response.text()}`)
      return
    }
    setToast('Approved — this revision is publishable')
    router.refresh()
  }

  async function setStatus(status: string, message: string) {
    if (!selected?.revision) return
    setBusy(status)
    const response = await fetch('/api/comments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision_status: status, revision_id: selected.revision.id }),
    })
    setBusy(null)
    setConfirmDelete(false)
    if (!response.ok) {
      setToast(`Could not update — ${await response.text()}`)
      return
    }
    setToast(message)
    router.refresh()
  }

  async function resolve(threadId: string, status: string) {
    setBusy(threadId)
    await fetch('/api/comments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, status }),
    })
    setBusy(null)
    router.refresh()
  }

  /**
   * Pulls the run's raw log.
   *
   * Polled while a run is going so the panel behaves like a terminal, and fetched once on
   * open otherwise. The endpoint refuses unless developer logs are switched on, so this
   * is dead weight in a demo rather than a hidden surface.
   */
  useEffect(() => {
    if (!logOpen || !selected?.revision) return
    let cancelled = false
    const pull = async () => {
      const response = await fetch(`/api/logs?revision=${selected.revision!.id}`, { cache: 'no-store' })
      if (!response.ok || cancelled) return
      const data = (await response.json()) as { log?: string; note?: string }
      setLogText(data.log || data.note || '(empty)')
    }
    pull()
    const timer = watching ? setInterval(pull, 2000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [logOpen, watching, selected?.revision])

  async function signOut() {
    await fetch('/api/session', { method: 'DELETE' })
    router.push('/')
  }

  const go = (next: { request?: string; canvas?: string }) => {
    const params = new URLSearchParams()
    params.set('request', next.request ?? selected?.request.id ?? '')
    if (next.canvas ?? canvasName) params.set('canvas', next.canvas ?? (canvasName as string))
    router.push(`/review?${params.toString()}`)
  }

  /**
   * Create the deployment for this revision and canvas.
   *
   * The tool's own fields are copied from the kit's most recent deployment, because
   * they describe the account rather than the ad — the campaign and objective are the
   * same next week as they were last week. Without a previous deployment there is
   * nothing to copy, and the button says so instead of sending blanks the agent will
   * stop on.
   */
  async function sendToDeploy(): Promise<string | null> {
    // A revision is required, not merely a request: the deployment names one.
    if (!selected?.revision || !deploy?.template) return null
    setBusy('deploy')
    const response = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `${selected.request.campaign_name} · rev ${selected.revision.n} · ${canvasName}`,
        revision_id: selected.revision.id,
        canvas_name: canvasName,
        target_campaign: deploy.template.campaign,
        target_objective: deploy.template.objective,
        target_fields: deploy.template.fields,
      }),
    })
    setBusy(null)
    const body = (await response.json()) as { deployment_id?: string; error?: string }
    if (!response.ok) {
      setToast(`Could not create the deployment — ${body.error}`)
      return null
    }
    setToast(`Deployment created from ${deploy.template.from}'s settings`)
    router.refresh()
    return body.deployment_id ?? null
  }

  /** Run it. Creates one first if this revision has none, so the button is never a dead end. */
  async function deployNow() {
    const id = deploy?.existing?.id ?? (await sendToDeploy())
    if (!id) return
    setBusy('deploy')
    const response = await fetch('/api/deploy', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deployment_id: id }),
    })
    setBusy(null)
    if (!response.ok) {
      const { error } = (await response.json()) as { error?: string }
      setToast(`Could not start — ${error}`)
      return
    }
    setDeployWatching(id)
    setDeployElapsed(0)
    setToast('Deploying — the box drives the tool and records what it does')
    router.refresh()
  }

  useEffect(() => {
    if (!deployWatching) return
    let cancelled = false
    const started = Date.now()
    const tick = setInterval(() => setDeployElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`/api/status?deployment=${deployWatching}`, { cache: 'no-store' })
        if (!response.ok || cancelled) return
        const body = (await response.json()) as {
          deployment: { status: string; recorded: boolean; verifiedUrl: string | null } | null
          run: { status: string } | null
        }
        if (!body.deployment || cancelled) return
        setDeployProgress((previous) =>
          previous
            ? {
                ...previous,
                status: body.deployment!.status,
                recorded: body.deployment!.recorded,
                verifiedUrl: body.deployment!.verifiedUrl,
                runStatus: body.run?.status ?? previous.runStatus,
              }
            : previous,
        )
        if (['published', 'unverified', 'stopped', 'failed'].includes(body.deployment.status)) {
          setDeployWatching(null)
          router.refresh()
        }
      } catch {
        /* a failed poll is not a failed deploy */
      }
    }, 2500)
    return () => {
      cancelled = true
      clearInterval(tick)
      clearInterval(poll)
    }
  }, [deployWatching, router])

  return (
    <>
      <div className="titlebar">
        <span className="brandmark">character.quilt</span>
        <span>Agent work</span>
        <span className="right">
          <span className="chip blue">{customerId}</span>
          {/* Onboarding a brand was reachable only from the rail's "Customers" item,
              which reads as a list to browse rather than a thing you can add to. The
              screen it opens is unchanged — same folder drop, same ingest, same
              findings — this is only a way in that says what it does. */}
          <a className="btn sm dark" href="/customers">+ Add customer</a>
          <a className="btn sm" href="/intake">New request</a>
          <a className="btn sm" href="/deploy">Deploy</a>
          <button className="btn sm ghost" onClick={signOut}>Switch customer</button>
        </span>
      </div>

      <div className="workspace">
        {/* Only destinations that exist. A rail item that goes nowhere is worse than
            an absent one: it reads as a feature and behaves as a dead end. */}
        <div className="rail">
          <a className="rail-item on" href="/review"><span className="g" />Agent work</a>
          <a className="rail-item" href="/brand"><span className="g" />Brand</a>
          <a className="rail-item" href="/customers"><span className="g" />Customers</a>
          <a className="rail-item" href="/deploy"><span className="g" />Deploy</a>
          <div className="spacer" />
        </div>

        <div className="col">
          <div className="col-head">Requests <span className="count">{requests.length}</span></div>
          {requests.map((r) => (
            <button
              key={r.id}
              className={`nav-item ${r.id === selected?.request.id ? 'on' : ''}`}
              onClick={() => go({ request: r.id, canvas: undefined })}
            >
              <span style={{ minWidth: 0 }}>
                {r.name}
                <span className="sub">
                  {/* State first, because it is the reason someone is looking. */}
                  <span className={`dot ${r.state.replace(/ /g, '-')}`} />
                  {r.state}
                  {r.latestN !== null && ` · rev ${r.latestN}`}
                  {r.renders > 0 && ` · ${r.renders} render${r.renders === 1 ? '' : 's'}`}
                </span>
                {r.state === 'not started' && (
                  <span className="sub warn-text">nothing ran — open it to start</span>
                )}
                {r.exitReason && r.exitReason !== 'completed' && (
                  <span className="sub warn-text">{r.exitReason.slice(0, 44)}</span>
                )}
              </span>
            </button>
          ))}
        </div>

        {!selected ? (
          <div className="canvas-col">
            <div className="empty">
              <div className="t">Nothing here yet</div>
              <div className="d">
                Describe what you want and the agent will build it against this customer&apos;s
                brand kit.
              </div>
              <a className="btn dark" href="/intake">New request</a>
            </div>
          </div>
        ) : (
          <div className="canvas-col">
            <div className="crumbs">
              {customerId} › {selected.request.campaign_name} › {canvasName ?? '—'}
            </div>
            <div className="canvas-title">
              {String(selected.request.copy?.headline ?? selected.request.campaign_name)}
              {canvas && <span className="badge">{canvas.width} × {canvas.height}</span>}
            </div>

            <div className="toolbar">
              <span className="seg">
                <button className={mode === 'pan' ? 'on' : ''} onClick={() => setMode('pan')}>Pan</button>
                <button className={mode === 'comment' ? 'on' : ''} onClick={() => setMode('comment')}>Comment</button>
              </span>
              <span className="seg">
                {selected.canvases.filter((c) => c.producible).map((c) => (
                  <button key={c.name} className={c.name === canvasName ? 'on' : ''} onClick={() => go({ canvas: c.name })}>
                    {c.name}
                  </button>
                ))}
              </span>
              <span className="right">
                <span className="pill">rev {selected.revision?.n ?? '—'} of {selected.revisions.length}</span>
                <button className="btn sm" disabled={busy !== null} onClick={() => startRun('rerender')}>
                  {busy === 'rerender' ? 'Re-rendering…' : 'Re-render'}
                </button>
                <button className="btn sm tinted" disabled={busy !== null || openCount === 0} onClick={() => startRun('revise')}>
                  Fix {openCount > 0 ? `(${openCount})` : ''}
                </button>
              </span>
            </div>

            <div className="hint">
              {mode === 'comment'
                ? 'Drag an area on the ad to comment on it, or click a spot'
                : 'Switch to Comment to annotate'}
            </div>

            {phantomRun && !watching && (
              <div className="banner stop">
                <span>
                  <b>This run never started.</b> A run was recorded but no sandbox was
                  ever created, so nothing is in progress. The usual cause is the
                  launcher refusing before it opened a box — a brand missing fonts, or a
                  sandbox image that needs rebuilding.
                </span>
              </div>
            )}

            {watching && (
              <div className="running">
                <div className="running-head">
                  <span className="beat" />
                  <b>Working in a sandbox</b>
                  <span className="mono">{elapsed}s</span>
                  <span className="right mono">typically 60–110s</span>
                </div>
                <div className="meter">
                  <span
                    style={{
                      width: `${Math.min(
                        95,
                        producibleCount
                          ? ((progress?.plates ?? 0) + (progress?.renders ?? 0)) /
                              (producibleCount * 2) *
                              100
                          : Math.min(90, elapsed),
                      )}%`,
                    }}
                  />
                </div>
                <div className="running-steps">
                  <span className={progress && progress.plates > 0 ? 'on' : ''}>
                    plates {progress?.plates ?? 0}/{producibleCount}
                  </span>
                  <span className={progress && progress.renders > 0 ? 'on' : ''}>
                    renders {progress?.renders ?? 0}/{producibleCount}
                  </span>
                  <span className={progress?.status === 'complete' ? 'on' : ''}>
                    {progress?.status ?? 'starting'}
                  </span>
                  <span className="right">
                    rev {progress?.n ?? '—'} · saved {progress?.artifacts ?? 0}
                  </span>
                </div>
                <div className="running-note">
                  Nothing is lost if you navigate away — the agent saves its own work as it
                  goes, and anything saved survives the box.
                </div>
              </div>
            )}

            <div className="stage">
              {url ? (
                <div
                  ref={artRef}
                  className={`art ${mode === 'comment' ? 'drawing' : ''}`}
                  onMouseDown={startDraw}
                  onMouseMove={moveDraw}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={`${canvasName} render`} style={{ maxHeight: '58vh' }} />

                  {threadsHere
                    .filter((t) => t.region_x !== null)
                    .map((t, i) => (
                      <div
                        key={t.id}
                        className={`region ${t.status === 'resolved' ? 'resolved' : ''}`}
                        style={{
                          left: `${(t.region_x as number) * 100}%`,
                          top: `${(t.region_y as number) * 100}%`,
                          width: `${(t.region_w as number) * 100}%`,
                          height: `${(t.region_h as number) * 100}%`,
                        }}
                      >
                        <span className="tag">
                          {i + 1} · {t.status}
                        </span>
                      </div>
                    ))}

                  {(drawing ?? pending) && (
                    <div
                      className="region pending"
                      style={{
                        left: `${((drawing ?? pending) as Region).x * 100}%`,
                        top: `${((drawing ?? pending) as Region).y * 100}%`,
                        width: `${((drawing ?? pending) as Region).w * 100}%`,
                        height: `${((drawing ?? pending) as Region).h * 100}%`,
                      }}
                    >
                      <span className="tag">new comment</span>
                      <span className="handle corner-tl" /><span className="handle corner-tr" />
                      <span className="handle corner-bl" /><span className="handle corner-br" />
                    </div>
                  )}
                </div>
              ) : (
                <div className="empty">
                  <div className="t">No render for this canvas yet</div>
                  <div className="d">
                    {selected.revision
                      ? `Revision ${selected.revision.n} is ${selected.revision.status}. A render appears here as soon as the agent saves one.`
                      : 'This request has no revisions yet.'}
                  </div>
                </div>
              )}
            </div>

            <div className="filmstrip">
              {selected.canvases.map((c) => (
                <button
                  key={c.name}
                  className={`fs ${c.name === canvasName ? 'on' : ''}`}
                  onClick={() => c.producible && go({ canvas: c.name })}
                  title={c.producible ? c.name : (c.refusal ?? 'not producible')}
                >
                  {selected.urls[c.name] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={selected.urls[c.name]} alt={c.name} />
                  ) : (
                    <span>{c.width}×{c.height}<br />{c.producible ? 'pending' : 'refused'}</span>
                  )}
                </button>
              ))}
              <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>
                {selected.canvases.filter((c) => c.producible).length} canvases
                {selected.canvases.some((c) => !c.producible) && ' · 1 refused'}
              </span>
            </div>
          </div>
        )}

        <div className="review">
          <div className="review-head">
            <span className="t">Review revision</span>
            <span className="right">
              <span
                className={`chip ${
                  selected?.revision?.approved_at
                    ? 'ok'
                    : selected?.revision?.status === 'complete'
                      ? 'blue'
                      : 'neutral'
                }`}
              >
                {selected?.revision?.approved_at ? 'approved' : (selected?.revision?.status ?? 'none')}
              </span>
            </span>
          </div>

          {selected?.revision ? (
            <div className="review-body">
              <div>
                <div className="rev-title">{selected.request.campaign_name}</div>
                <div className="rev-sub">
                  rev {selected.revision.n} · {selected.artifacts.length} artifacts
                </div>
              </div>

              <div className="grid2">
                <button
                  className="btn primary wide"
                  disabled={busy !== null || selected.revision.status !== 'complete' || Boolean(selected.revision.approved_at)}
                  onClick={() => approve()}
                  title={
                    selected.revision.status !== 'complete'
                      ? 'only a complete revision can be approved'
                      : 'mark this revision publishable'
                  }
                >
                  {selected.revision.approved_at ? 'Approved' : 'Approve'}
                </button>
                <button
                  className="btn tinted wide"
                  disabled={busy !== null || openCount === 0}
                  onClick={() => startRun('revise')}
                >
                  Render new version
                </button>
              </div>
              {/*
                Deploy, from the screen where the ad is actually looked at.
                Approval is the gate, so both buttons stay disabled until then — and
                the reason is in the title, because a disabled button that will not say
                why is indistinguishable from a broken one.
              */}
              <div className="grid2">
                <button
                  className="btn wide"
                  disabled={
                    busy !== null ||
                    !selected.revision.approved_at ||
                    !deploy?.template ||
                    Boolean(deploy?.existing)
                  }
                  onClick={() => void sendToDeploy()}
                  title={
                    !selected.revision.approved_at
                      ? 'approve this revision first'
                      : !deploy?.template
                        ? 'no previous deployment to copy the tool’s fields from — set one up on the Deploy page once'
                        : deploy?.existing
                          ? `already sent as “${deploy.existing.name}”`
                          : `create a deployment for ${canvasName} using ${deploy?.template?.from}’s settings`
                  }
                >
                  {deploy?.existing ? 'Sent to deploy' : 'Send to deploy'}
                </button>
                <button
                  className="btn wide primary"
                  disabled={
                    busy !== null ||
                    !selected.revision.approved_at ||
                    !deploy?.template ||
                    deployWatching !== null
                  }
                  onClick={() => void deployNow()}
                  title={
                    !selected.revision.approved_at
                      ? 'approve this revision first'
                      : !deploy?.template
                        ? 'set up one deployment on the Deploy page first, so there are tool fields to copy'
                        : `publish ${canvasName} to the ad tool`
                  }
                >
                  {deployWatching ? 'Deploying…' : 'Deploy now'}
                </button>
              </div>

              {deployWatching && (
                <div className="running">
                  <div className="running-head">
                    <span className="beat" />
                    <b>Driving the ad tool</b>
                    <span className="mono">{deployElapsed}s</span>
                    <span className="right mono">typically 90–180s</span>
                  </div>
                  <div className="meter">
                    <span
                      style={{
                        width: `${Math.min(
                          95,
                          Math.max(
                            Math.min(35, deployElapsed),
                            (deployStages(deployProgress).filter((x) => x.done).length / 4) * 100,
                          ),
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="running-steps">
                    {deployStages(deployProgress).map((stage) => (
                      <span key={stage.label} className={stage.done ? 'on' : ''}>
                        {stage.label}
                      </span>
                    ))}
                    <span className="right">{deployProgress?.runStatus ?? 'starting'}</span>
                  </div>
                  <div className="running-note">
                    Published only once a recording exists and a url has been read back off the
                    tool’s own page. Anything else stays unverified.
                  </div>
                </div>
              )}

              {deploy?.existing && !deployWatching && (
                <div className="banner info">
                  <span>
                    <b>{deploy.existing.status}</b>
                    {deploy.existing.canvasName ? ` · ${deploy.existing.canvasName}` : ''}
                    {deploy.existing.verifiedUrl ? (
                      <>
                        {' · '}
                        <a href={deploy.existing.verifiedUrl} target="_blank" rel="noreferrer">
                          view on the tool
                        </a>
                      </>
                    ) : (
                      ' · no url read back yet'
                    )}
                  </span>
                  <a className="btn sm" href="/deploy">Deploy page</a>
                </div>
              )}

              {/* Beautify and Human help were in the reference and are not built, so they
                  are not here. A disabled button is a promise nobody kept. */}
              <div className="grid2">
                <button className="btn wide" disabled={busy !== null} onClick={() => startRun('rerender')}>
                  Re-render
                </button>
                <button className="btn wide danger" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
                  Delete revision
                </button>
              </div>

              <div className="cost">
                <b>Re-render</b> reuses the plate — layout only, free and seconds.{' '}
                <b>Render new version</b> sends the open comments to the agent and costs an
                image call per canvas.
              </div>

              {devLogs && (
                <button className="btn wide sm" onClick={() => setLogOpen((v) => !v)}>
                  {logOpen ? 'Hide developer logs' : 'Developer logs'}
                </button>
              )}

              {devLogs && logOpen && (
                <pre className="devlog">{logText || 'loading…'}</pre>
              )}

              <div className="counters">
                <span className="chip neutral">{openCount} open</span>
                <span className="chip neutral">{selected.revisions.length} revisions</span>
                {selected.findings.length > 0 && (
                  <span className="chip warn">{selected.findings.length} findings</span>
                )}
              </div>

              {pending && (
                <div className="compose">
                  <div className="lab">New comment</div>
                  <div className="sel">
                    Selected area · {canvasName} ·{' '}
                    <span className="mono">
                      {Math.round(pending.w * 100)}% × {Math.round(pending.h * 100)}%
                    </span>
                  </div>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="What should change in this area?"
                    autoFocus
                  />
                  <div className="foot">
                    <button className="btn sm" onClick={() => { setPending(null); setText('') }}>Cancel</button>
                    <span className="right">
                      <button className="btn sm" disabled={!text.trim() || busy !== null} onClick={() => saveComment(false)}>
                        Add comment
                      </button>
                      <button className="btn sm primary" disabled={!text.trim() || busy !== null} onClick={() => saveComment(true)}>
                        Render new version
                      </button>
                    </span>
                  </div>
                  <div className="why">
                    Comments attach to this region and travel to the agent as the instruction
                    for the next revision.
                  </div>
                </div>
              )}

              {threadsHere.map((t, i) => (
                <div key={t.id} className={`thread ${t.status === 'resolved' ? 'resolved' : ''}`}>
                  <div className="who">
                    <span className="av" />
                    <b>Comment {i + 1}</b>
                    <span className="when">{t.canvas_name ?? 'request'}</span>
                  </div>
                  {messagesFor(t.id).map((m) => (
                    <div key={m.id}>
                      <div className="body">{m.body}</div>
                      {m.instruction && m.instruction !== m.body && (
                        <div className="meta">to the agent: {m.instruction}</div>
                      )}
                    </div>
                  ))}
                  <div className="foot">
                    <button
                      disabled={busy !== null}
                      onClick={() => resolve(t.id, t.status === 'open' ? 'resolved' : 'open')}
                    >
                      {t.status === 'open' ? 'Resolve' : 'Reopen'}
                    </button>
                  </div>
                </div>
              ))}

              {selected.findings.map((f, i) => (
                <div key={i} className="thread">
                  <div className="who">
                    <span className="av agent" />
                    <b>Agent</b>
                    <span className="when">rev {selected.revision?.n}</span>
                  </div>
                  <div className="body">{f.detail}</div>
                  <div className="meta">{f.code} · {f.severity}</div>
                </div>
              ))}

              {threadsHere.length === 0 && selected.findings.length === 0 && (
                <div className="banner info">
                  No comments yet. Drag an area on the ad to leave one.
                </div>
              )}
            </div>
          ) : (
            <div className="review-body">
              <div className="banner info">No revision to review on this request yet.</div>
            </div>
          )}
        </div>
      </div>

      {confirmDelete && (
        <div className="scrim" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="h">
              Delete revision {selected?.revision?.n}?
              <button onClick={() => setConfirmDelete(false)}>✕</button>
            </div>
            <div className="s">
              The artifacts stay in storage, so this is reversible — a run cannot delete
              what it saved. The revision is marked deleted and drops out of review.
            </div>
            <div className="foot">
              <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button
                className="btn danger"
                disabled={busy !== null}
                onClick={() => setStatus('deleted', 'Revision deleted')}
              >
                Delete revision
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
