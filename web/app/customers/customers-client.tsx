'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Kit {
  id: string
  customer_id: string
  display_name: string
  ingest_status: string
  usable: number
  fonts: number
  findings: number
  blockers: { code: string; detail: string }[]
}

const slug = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

export default function CustomersClient({
  currentCustomer,
  kits,
}: {
  /** Null when this screen was opened from sign-in, before a customer was chosen. */
  currentCustomer: string | null
  kits: Kit[]
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [name, setName] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const customerId = slug(name)
  const kitId = customerId ? `bk-${customerId}-2026` : ''
  const ready = Boolean(customerId && files.length > 0)

  /**
   * A dropped folder keeps its shape.
   *
   * `brand/` and `fonts/` mean something to ingest, so the relative path of each file is
   * sent alongside it. Flattening the folder would turn a manifest's `brand/logo.svg`
   * into a broken reference and every asset would come back unavailable.
   */
  async function collect(list: FileList | null) {
    if (!list) return
    setFiles(Array.from(list))
    setError(null)
  }

  async function submit() {
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.set('customer_id', customerId)
    form.set('kit_id', kitId)
    form.set('display_name', name.trim())
    for (const file of files) {
      form.append('files', file)
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
      // Strip the dropped folder's own name so `northwind-foods/DESIGN.md` becomes
      // `DESIGN.md` — the kit id already names the customer.
      const path = relative ? relative.split('/').slice(1).join('/') || file.name : file.name
      form.set(`path:${file.name}`, path)
    }
    const response = await fetch('/api/customer', { method: 'POST', body: form })
    setBusy(false)
    if (!response.ok) {
      const { error: message } = (await response.json()) as { error?: string }
      setError(message ?? 'could not add the customer')
      return
    }
    const { kit_id } = (await response.json()) as { kit_id: string }
    setFiles([])
    setName('')
    setToast(`Ingesting ${kit_id} — refresh in a few seconds to see the findings`)
    setTimeout(() => router.refresh(), 4000)
  }

  return (
    <>
      {/* Signed out, the work links go nowhere — both bounce back to sign-in — so they
          are replaced by the one destination that works. A link that returns you to
          where you came from reads as a broken screen rather than a guarded one. */}
      <div className="titlebar">
        <a className="brandmark" href={currentCustomer ? '/review' : '/'}>character.quilt</a>
        <span>Customers</span>
        <span className="right">
          {currentCustomer ? (
            <>
              <span className="chip blue">{currentCustomer}</span>
              <a className="btn sm" href="/review">Agent work</a>
              <a className="btn sm" href="/brand">Brand</a>
            </>
          ) : (
            <a className="btn sm" href="/">Choose a customer</a>
          )}
        </span>
      </div>

      <div className="page">
        <div className="page-head">
          <div>
            <div className="h">Customers and brand kits</div>
            <div className="s">
              Drop a folder to add a customer. A kit is only usable once ingest has read its
              brand — a kit that cannot be read is marked <b>blocked</b> and no run will
              start against it.
            </div>
          </div>
        </div>

        <div className="kitbox">
          <div className="section-label"><b>Add a customer</b></div>
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <input
              className="composer-input"
              placeholder="Customer name, e.g. Northwind Foods"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="pill mono" title="derived from the name, not typed">
              {kitId || 'bk-…-2026'}
            </span>
          </div>

          <label
            className={`drop ${over ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); collect(e.dataTransfer.files) }}
          >
            <input
              ref={inputRef}
              type="file"
              hidden
              multiple
              // Lets a whole kit folder be chosen, preserving brand/ and fonts/.
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(e) => collect(e.target.files)}
            />
            <div style={{ fontSize: 12.5, fontWeight: 580 }}>
              {files.length > 0
                ? `${files.length} file${files.length === 1 ? '' : 's'} ready`
                : 'Drop a brand kit folder, or click to choose one'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              DESIGN.md, brand/asset_manifest.json, logos and fonts. The folder structure is
              kept — brand/ and fonts/ mean something to ingest.
            </div>
          </label>

          {files.length > 0 && (
            <div className="filelist">
              {files.slice(0, 8).map((f) => (
                <div className="f" key={f.name}>
                  <span className="mono">
                    {(f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name}
                  </span>
                  <span className="right">{Math.round(f.size / 1024)} KB</span>
                </div>
              ))}
              {files.length > 8 && <div className="dim">…and {files.length - 8} more</div>}
            </div>
          )}

          {error && <span className="chip stop">{error}</span>}

          <div style={{ display: 'flex', gap: 7 }}>
            <button className="btn dark" disabled={!ready || busy} onClick={submit}>
              {busy ? 'Uploading…' : 'Add customer and ingest'}
            </button>
            {files.length > 0 && (
              <button className="btn" onClick={() => setFiles([])}>Clear</button>
            )}
          </div>
          <div className="dim">
            An uploaded manifest cannot assign ownership. If it names another customer&apos;s
            kit, the assets are still stored under this one and the claim is recorded — an
            upload is not a way to write into somebody else&apos;s brand.
          </div>
        </div>

        <div className="panel">
          <div className="trow head" style={{ gridTemplateColumns: '1.4fr 1.4fr 90px 70px 70px 1fr' }}>
            <span>Customer</span><span>Kit</span><span>Status</span><span>Assets</span><span>Fonts</span><span>Findings</span>
          </div>
          {kits.map((k) => (
            <div className="trow" key={k.id} style={{ gridTemplateColumns: '1.4fr 1.4fr 90px 70px 70px 1fr' }}>
              <div>
                <div style={{ fontWeight: 560 }}>{k.display_name}</div>
                <div className="dim">{k.customer_id}</div>
              </div>
              <span className="mono">{k.id}</span>
              <span>
                <span
                  className={`chip ${
                    k.ingest_status === 'ready' ? 'ok' : k.ingest_status === 'blocked' ? 'stop' : 'warn'
                  }`}
                >
                  {k.ingest_status}
                </span>
              </span>
              <span className="mono">{k.usable}</span>
              <span className="mono">{k.fonts}</span>
              <div>
                {k.findings === 0 ? (
                  <span className="dim">none</span>
                ) : (
                  <span className={`chip ${k.blockers.length ? 'stop' : 'warn'}`}>
                    {k.findings} {k.blockers.length ? '· blocking' : ''}
                  </span>
                )}
                {k.blockers.map((b) => (
                  <div className="dim" key={b.code}>{b.detail}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {toast && (
        <div className="toast">
          {toast}
          <button onClick={() => setToast(null)}>Dismiss</button>
        </div>
      )}
    </>
  )
}
