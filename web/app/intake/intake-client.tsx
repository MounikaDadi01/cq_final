'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const SIZES = [
  { name: 'square', label: 'square · 1080×1080' },
  { name: 'landscape', label: 'landscape · 1200×628' },
  { name: 'portrait', label: 'portrait · 1080×1350' },
  { name: 'leaderboard', label: 'leaderboard · 728×90' },
]

interface Template {
  id: string
  kitId: string
  campaign: string
  headline: string | null
  subhead: string | null
  eyebrow: string | null
  cta: string | null
  plateDirection: string | null
  canvases: string[]
}

interface PastWork {
  revisionId: string
  n: number
  kitId: string
  campaign: string
  approvedAt: string
  canvases: string[]
}

interface Props {
  customerId: string
  kits: { id: string; display_name: string; ingest_status: string }[]
  /**
   * The four sources the composer draws on, kept apart deliberately.
   *
   * A template is the *brief* said again — copy, sizes, direction. Past work is the
   * *output* said again — a finished, approved ad. Merging them into one "start from
   * something" picker would lose that difference, and it is the difference an operator
   * is actually choosing between.
   */
  sources: {
    assets: { kit_id: string; kind: string; available: boolean }[]
    fonts: { kit_id: string; family_slug: string }[]
    findings: { kit_id: string | null; code: string; severity: string; detail: string }[]
    inspirations: Record<string, string[]>
    templates: Template[]
    pastWork: PastWork[]
  }
}

export default function IntakeClient({ customerId, kits, sources }: Props) {
  const router = useRouter()
  const [kitId, setKitId] = useState(kits[0]?.id ?? '')
  const [name, setName] = useState('')
  const [eyebrow, setEyebrow] = useState('')
  const [headline, setHeadline] = useState('')
  const [subhead, setSubhead] = useState('')
  const [cta, setCta] = useState('')
  const [direction, setDirection] = useState('')
  const [sizes, setSizes] = useState<string[]>(['square', 'landscape', 'portrait'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState<string[]>([])
  const [over, setOver] = useState(false)
  // Choosing an inspiration is its own step, so it has its own state rather than being
  // folded into the copy fields.
  const [chosen, setChosen] = useState<string[]>([])
  const [startedFrom, setStartedFrom] = useState<string | null>(null)


  // Everything below is scoped to the selected kit. A source that showed another kit's
  // contents would be a leak dressed up as a convenience.
  const kitAssets = sources.assets.filter((a) => a.kit_id === kitId)
  const kitFonts = sources.fonts.filter((f) => f.kit_id === kitId)
  const kitFindings = sources.findings.filter((f) => f.kit_id === kitId)
  const kitTemplates = sources.templates.filter((t) => t.kitId === kitId)
  const kitPastWork = sources.pastWork.filter((w) => w.kitId === kitId)
  const kitInspirations = sources.inspirations[kitId] ?? []

  /**
   * A kit with no font files cannot be rendered, so the form refuses rather than
   * letting the launcher refuse later.
   *
   * SKILL.md is explicit — "Every family named in DESIGN.md must be loaded from that
   * brain's fonts/ and applied in the render. Browser fallback is not the brand." With
   * zero font files there is nothing to substitute *from*, which is different from a
   * substitution like Barlow Condensed → Barlow, and that difference is why this
   * blocks instead of warning.
   *
   * Caught here because the alternative is what happened: a campaign filled in, a
   * request committed, and the failure arriving from a sandbox launcher four fields
   * later.
   */
  const kitCanRender = kitFonts.length > 0
  const missingFamilies = [
    ...new Set(
      kitFindings
        .filter((f) => f.code === 'font-unresolvable' || f.code === 'no-fonts')
        .flatMap((f) => f.detail.match(/"([^"]+)"/g) ?? [])
        .map((q) => q.replace(/"/g, '')),
    ),
  ]

  const ready = Boolean(kitId && name.trim() && headline.trim()) && kitCanRender

  /** Start from a previous brief: the copy and sizes, not the pictures. */
  function useTemplate(t: Template) {
    setName(`${t.campaign} (again)`)
    setHeadline(t.headline ?? '')
    setSubhead(t.subhead ?? '')
    setEyebrow(t.eyebrow ?? '')
    setCta(t.cta ?? '')
    setDirection(t.plateDirection ?? '')
    if (t.canvases.length) setSizes(t.canvases)
    setStartedFrom(`template · ${t.campaign}`)
  }

  /**
   * Start from finished work: its brief, plus its sizes.
   *
   * It does not carry the rendered image forward, and that is on purpose — a new
   * request generates new plates. What is reused is the decision, not the pixels.
   */
  function usePastWork(w: PastWork) {
    const brief = sources.templates.find((t) => t.campaign === w.campaign && t.kitId === w.kitId)
    setName(`${w.campaign} (from rev ${w.n})`)
    if (brief) {
      setHeadline(brief.headline ?? '')
      setSubhead(brief.subhead ?? '')
      setEyebrow(brief.eyebrow ?? '')
      setCta(brief.cta ?? '')
      setDirection(brief.plateDirection ?? '')
    }
    if (w.canvases.length) setSizes(w.canvases)
    setStartedFrom(`past work · ${w.campaign} rev ${w.n}`)
  }

  async function submit() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kit_id: kitId,
        campaign_name: name.trim(),
        eyebrow: eyebrow.trim() || null,
        headline: headline.trim(),
        subhead: subhead.trim() || null,
        cta: cta.trim() || 'Learn more',
        plate_direction: direction.trim() || null,
        canvases: sizes,
        // Its own step, so its own field. Empty means none attached, which the
        // launcher already treats as "generate without a reference".
        inspirations: chosen,
      }),
    })
    if (!response.ok) {
      const { error: message } = (await response.json()) as { error?: string }
      setError(message ?? 'could not create the request')
      setBusy(false)
      return
    }
    const { request_id } = (await response.json()) as { request_id: string }
    router.push(`/review?request=${request_id}`)
  }

  /**
   * Upload files into a brand kit this customer owns.
   *
   * The kit prefix is the boundary: storage policy allows a write only under a kit id
   * belonging to the session customer, so a mistake here is refused rather than
   * writing into someone else's brand.
   */
  async function upload(files: FileList | null) {
    if (!files || !kitId) return
    setUploading(true)
    setError(null)
    const form = new FormData()
    form.set('kit_id', kitId)
    for (const file of Array.from(files)) form.append('files', file)
    const response = await fetch('/api/kit', { method: 'POST', body: form })
    setUploading(false)
    if (!response.ok) {
      const { error: message } = (await response.json()) as { error?: string }
      setError(message ?? 'upload failed')
      return
    }
    const { stored } = (await response.json()) as { stored: string[] }
    setUploaded((prior) => [...prior, ...stored])
  }

  return (
    <>
      <div className="titlebar">
        <a className="brandmark" href="/review">character.quilt</a>
        <span>New request</span>
        <span className="right">
          <span className="chip blue">{customerId}</span>
          <a className="btn sm" href="/review">Back to work</a>
        </span>
      </div>

      <div className="intake">
        <div className="stepper">
          <span className="step on"><span className="n">1</span> Describe request</span>
          <span style={{ color: 'var(--muted-2)' }}>›</span>
          <span className="step"><span className="n">2</span> Agent builds it</span>
          <span style={{ color: 'var(--muted-2)' }}>›</span>
          <span className="step"><span className="n">3</span> Review and approve</span>
          <span style={{ color: 'var(--muted-2)' }}>›</span>
          <span className="step"><span className="n">4</span> Deploy</span>
        </div>

        <div className="hero">
          <div className="h">What do you want to build?</div>
          <div className="s">
            The agent pulls from this brand&apos;s own Brain and stays inside its guardrails.
          </div>
        </div>

        <div className="composer">
          <div className="row">
            <select
              className="pill"
              value={kitId}
              onChange={(e) => setKitId(e.target.value)}
              style={{ paddingRight: 24 }}
            >
              {kits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.display_name} · {k.id}
                </option>
              ))}
            </select>
            {kits.find((k) => k.id === kitId)?.ingest_status !== 'ready' && (
              <span className="chip warn">this kit is not ingested yet</span>
            )}
            {kitCanRender === false && (
              <span className="chip stop">no fonts — cannot render</span>
            )}
          </div>

          <input
            className="composer-input"
            placeholder="Campaign name, e.g. Capital projects launch"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            placeholder="The headline. This is the line a person reads first."
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            style={{ minHeight: 56 }}
          />
          <div className="row">
            <input className="composer-input" placeholder="Eyebrow (optional)" value={eyebrow} onChange={(e) => setEyebrow(e.target.value)} />
            <input className="composer-input" placeholder="Button text" value={cta} onChange={(e) => setCta(e.target.value)} />
          </div>
          <input className="composer-input" placeholder="Subhead (optional)" value={subhead} onChange={(e) => setSubhead(e.target.value)} />
          <textarea
            placeholder="What the photograph should show, and where to leave space empty for the words. Leave blank and the agent will decide."
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          />

          <div className="row">
            {SIZES.map((s) => (
              <button
                key={s.name}
                type="button"
                className={`pill ${sizes.includes(s.name) ? 'on' : ''}`}
                onClick={() =>
                  setSizes((prior) =>
                    prior.includes(s.name) ? prior.filter((n) => n !== s.name) : [...prior, s.name],
                  )
                }
              >
                {s.label}
              </button>
            ))}
          </div>
          {!kitCanRender && (
            <div className="banner stop">
              <span>
                <b>This brand ships no font files.</b> A render would fall back to a
                system typeface, which is not the brand — so the request is not accepted
                rather than producing something off-brand.
                {missingFamilies.length > 0 && (
                  <>
                    {' '}
                    <b>DESIGN.md names:</b> {missingFamilies.join(', ')}.
                  </>
                )}{' '}
                Upload a font file to this kit&apos;s <code>fonts/</code> to continue.
              </span>
              <a className="btn sm" href="/brand">Add fonts</a>
            </div>
          )}

          {sizes.includes('leaderboard') && (
            <div className="chip warn" style={{ alignSelf: 'flex-start' }}>
              728×90 cannot be generated — it will be reported, not attempted
            </div>
          )}

          {/*
            The four sources, named and separated.
            Brand Kit and Brain describe what the agent must obey. Templates and Past
            work are optional starting points — and they are different starting points:
            a template is the brief again, past work is a finished ad again.
          */}
          <div className="section-label" style={{ marginTop: 14 }}>
            <b>Sources</b> — what this request draws on
          </div>

          <div className="sources">
            <div className="source">
              <div className="source-head">Brand Kit</div>
              <div className="dim">
                {kitAssets.filter((a) => a.available).length} asset(s) ·{' '}
                {new Set(kitFonts.map((f) => f.family_slug)).size} font famil
                {new Set(kitFonts.map((f) => f.family_slug)).size === 1 ? 'y' : 'ies'}
              </div>
              {kitAssets.some((a) => !a.available) && (
                <div className="dim">
                  {kitAssets.filter((a) => !a.available).length} listed but unavailable
                </div>
              )}
            </div>

            <div className="source">
              <div className="source-head">Brain</div>
              <div className="dim">DESIGN.md — palette, type, scale</div>
              {kitFindings.length > 0 ? (
                <div className="dim">
                  {kitFindings.length} finding(s) the agent is told about
                </div>
              ) : (
                <div className="dim">nothing unresolved</div>
              )}
            </div>

            <div className="source">
              <div className="source-head">Templates</div>
              {kitTemplates.length === 0 ? (
                <div className="dim">no earlier campaign to start from</div>
              ) : (
                <div className="source-list">
                  {kitTemplates.slice(0, 4).map((t) => (
                    <button key={t.id} type="button" className="linkish" onClick={() => useTemplate(t)}>
                      {t.campaign} · {t.canvases.length} size(s)
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="source">
              <div className="source-head">Past work</div>
              {kitPastWork.length === 0 ? (
                <div className="dim">nothing approved yet</div>
              ) : (
                <div className="source-list">
                  {kitPastWork.slice(0, 4).map((w) => (
                    <button
                      key={w.revisionId}
                      type="button"
                      className="linkish"
                      onClick={() => usePastWork(w)}
                    >
                      {w.campaign} · rev {w.n}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {startedFrom && (
            <div className="chip blue" style={{ alignSelf: 'flex-start' }}>
              started from {startedFrom} — edit anything below
            </div>
          )}

          {/*
            Choosing an inspiration is its own step.
            Only files named for this brand appear, which is the same rule the launcher
            applies when attaching them — so nothing offered here can be silently
            dropped later.
          */}
          <div className="section-label" style={{ marginTop: 14 }}>
            <b>Inspiration</b> — reference designs for the plate, optional
          </div>
          {kitInspirations.length === 0 ? (
            <div className="dim">
              No inspirations staged for this brand. A file is only used when its name
              begins with the brand, e.g. <code>{kitId.replace(/^bk-/, '').replace(/-\d{4}$/, '')}-hero.png</code>.
            </div>
          ) : (
            <>
              <div className="row wrap">
                {kitInspirations.map((file) => (
                  <button
                    key={file}
                    type="button"
                    className={`pill ${chosen.includes(file) ? 'on' : ''}`}
                    onClick={() =>
                      setChosen((prior) =>
                        prior.includes(file) ? prior.filter((f) => f !== file) : [...prior, file],
                      )
                    }
                  >
                    {file}
                  </button>
                ))}
              </div>
              <div className="dim">
                {chosen.length === 0
                  ? 'None chosen — the plate is generated from the brief alone.'
                  : `${chosen.length} attached. The agent is told to follow their composition, never to copy them.`}
              </div>
            </>
          )}

          <div className="foot">
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {sizes.length} size{sizes.length === 1 ? '' : 's'}
            </span>
            <span className="right">
              {error && <span className="chip stop">{error}</span>}
              <button className="round" disabled={!ready || busy} onClick={submit} title="Build it">
                {busy ? '·' : '→'}
              </button>
            </span>
          </div>
        </div>

        <div className="kitbox">
          <div className="section-label">
            <b>Brand kit</b> — add or replace files in {kitId}
          </div>
          <label
            className={`drop ${over ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files) }}
          >
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => upload(e.target.files)}
              accept=".md,.json,.svg,.png,.ttf,.woff2"
            />
            <div style={{ fontSize: 12.5, fontWeight: 580 }}>
              {uploading ? 'Uploading…' : 'Drop DESIGN.md, logos or fonts here'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Files land under this kit only. A run reads them fresh on its next build.
            </div>
          </label>
          {uploaded.length > 0 && (
            <div className="filelist">
              {uploaded.map((f) => (
                <div className="f" key={f}>
                  <span className="chip ok">stored</span>
                  <span className="mono">{f}</span>
                </div>
              ))}
              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                Uploading a file does not re-ingest the kit. The asset manifest and font
                index are rebuilt by ingest, which is a backend job.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
