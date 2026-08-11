import { redirect } from 'next/navigation'
import { read, session } from '@/lib/read'

/**
 * The screen behind the Brand rail item.
 *
 * Not decoration: brand kits arrive with real problems, and every one the system found
 * belongs somewhere a person can see it before wondering why an ad looks as it does.
 * Read-only — curating a kit is uploading files and re-ingesting, not editing rows.
 */
export default async function BrandPage() {
  const current = await session()
  if (!current) redirect('/')
  const { token, customerId } = current

  const kits = await read<{ id: string; display_name: string; ingest_status: string }[]>(
    token,
    'brand_kits?select=id,display_name,ingest_status&order=id',
  )
  const assets = await read<
    { kit_id: string; kind: string; manifest_path: string; available: boolean; unavailable_reason: string | null; notes: string | null }[]
  >(token, 'brand_assets?select=kit_id,kind,manifest_path,available,unavailable_reason,notes&order=kind')
  const fonts = await read<{ kit_id: string; family_slug: string; weight: number }[]>(
    token,
    'brand_fonts?select=kit_id,family_slug,weight&order=family_slug,weight',
  )
  const findings = await read<{ kit_id: string | null; code: string; severity: string; detail: string }[]>(
    token,
    'findings?revision_id=is.null&select=kit_id,code,severity,detail',
  )

  return (
    <>
      <div className="titlebar">
        <a className="brandmark" href="/review">character.quilt</a>
        <span>Brand</span>
        <span className="right">
          <span className="chip blue">{customerId}</span>
          <a className="btn sm" href="/review">Agent work</a>
          <a className="btn sm" href="/intake">New request</a>
        </span>
      </div>

      <div className="page">
        {kits.map((kit) => {
          const own = assets.filter((a) => a.kit_id === kit.id)
          const ownFonts = fonts.filter((f) => f.kit_id === kit.id)
          const ownFindings = findings.filter((f) => f.kit_id === kit.id)
          return (
            <div key={kit.id} className="stack">
              <div className="page-head">
                <div>
                  <div className="h">{kit.display_name}</div>
                  <div className="s mono">{kit.id}</div>
                </div>
                <span className="right">
                  <span className={`chip ${kit.ingest_status === 'ready' ? 'ok' : 'warn'}`}>
                    {kit.ingest_status}
                  </span>
                  <a className="btn sm" href="/intake">Upload files</a>
                </span>
              </div>

              <div className="two">
                <div className="panel">
                  <div className="panel-head">
                    Assets <span className="right">{own.filter((a) => a.available).length} of {own.length} usable</span>
                  </div>
                  {own.map((a) => (
                    <div className="arow" key={a.manifest_path}>
                      <div>
                        <div>{a.kind}</div>
                        <div className="mono dim">{a.manifest_path}</div>
                        {a.notes && <div className="dim">{a.notes}</div>}
                      </div>
                      <span className="right">
                        {a.available ? (
                          <span className="chip ok">available</span>
                        ) : (
                          <span className="chip stop" title={a.unavailable_reason ?? ''}>no file</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="panel">
                  <div className="panel-head">
                    Fonts <span className="right">{ownFonts.length} faces shipped</span>
                  </div>
                  {ownFonts.map((f) => (
                    <div className="arow" key={`${f.family_slug}-${f.weight}`}>
                      <div>
                        <div>{f.family_slug}</div>
                        <div className="mono dim">weight {f.weight}</div>
                      </div>
                      <span className="right"><span className="chip ok">shipped</span></span>
                    </div>
                  ))}
                  {ownFonts.length === 0 && (
                    <div className="arow"><div className="dim">No font files. A render would fall back and be off-brand.</div></div>
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  Findings <span className="right">{ownFindings.length} · none blocking</span>
                </div>
                {ownFindings.map((f, i) => (
                  <div className="arow" key={i}>
                    <div>
                      <div><b>{f.code}</b></div>
                      <div className="dim">{f.detail}</div>
                    </div>
                    <span className="right"><span className="chip warn">{f.severity}</span></span>
                  </div>
                ))}
                {ownFindings.length === 0 && (
                  <div className="arow"><div className="dim">Nothing flagged during ingest.</div></div>
                )}
              </div>

              <div className="banner">
                <span>
                  <b>brand/tokens.json is withheld from every run.</b> It disagrees with
                  DESIGN.md and is the newer file, so anything resolving by recency would pick
                  wrong three times over. Not shipping it is the cheapest way to not consult it.
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

export const dynamic = 'force-dynamic'
