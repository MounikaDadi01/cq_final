import { redirect } from 'next/navigation'
import { listObjects, read, session } from '@/lib/read'
import IntakeClient from './intake-client'

/**
 * Screen 1: describe the work.
 *
 * The kits offered are the ones this customer owns, read with the session token — so
 * the picker cannot show, and the form cannot target, anybody else's brand.
 *
 * The composer draws on four sources, and the packet asks for them to be four separate
 * things rather than one blurred "context" blob:
 *
 *   Brand Kit   the files — assets and fonts, per kit
 *   Brain       DESIGN.md and what could be resolved from it
 *   Templates   an existing campaign's *brief* — copy, sizes, direction — to start again from
 *   Past work   a previously approved *revision* — a finished ad — to build on
 *
 * The last two are close enough to conflate and worth keeping apart: a template hands
 * back the instructions, past work hands back the output. Both read rows that already
 * exist, so neither invents a new kind of storage.
 *
 * Every read here uses the session token, so a source can only offer what this
 * customer was already entitled to see.
 */
export default async function IntakePage() {
  const current = await session()
  if (!current) redirect('/')
  const { token, customerId } = current

  const kits = await read<{ id: string; display_name: string; ingest_status: string }[]>(
    token,
    'brand_kits?select=id,display_name,ingest_status&order=id',
  )

  // Brand Kit — what each kit ships. Counted rather than listed: the count is what
  // tells you a kit is thin, and the Brand screen already shows the detail.
  const assets = await read<{ kit_id: string; kind: string; available: boolean }[]>(
    token,
    'brand_assets?select=kit_id,kind,available',
  )
  const fonts = await read<{ kit_id: string; family_slug: string }[]>(
    token,
    'brand_fonts?select=kit_id,family_slug',
  )

  // Brain — kit-level findings, which are the honest summary of what could and could
  // not be resolved from DESIGN.md. A composer that shows this is one you can catch
  // being wrong before it renders.
  const findings = await read<
    { kit_id: string | null; code: string; severity: string; detail: string }[]
  >(token, 'findings?select=kit_id,code,severity,detail&revision_id=is.null')

  // Templates — every campaign brief this customer has submitted.
  const requests = await read<
    {
      id: string
      kit_id: string
      campaign_name: string
      // The copy lives in one jsonb column, not four text columns. Selecting the
      // fields individually returns `column requests.headline does not exist`.
      copy: Record<string, string | null> | null
      plate_direction: string | null
      created_at: string
      request_canvases: { name: string }[]
    }[]
  >(
    token,
    'requests?select=id,kit_id,campaign_name,copy,plate_direction,created_at,' +
      'request_canvases(name)&order=created_at.desc',
  )

  // Past work — approved revisions only. An unapproved ad is not something to base new
  // work on, and offering one would quietly lower the bar for what ships.
  const approved = await read<{ id: string; n: number; request_id: string; approved_at: string }[]>(
    token,
    'revisions?approved_at=not.is.null&select=id,n,request_id,approved_at&order=approved_at.desc',
  )
  const renders = await read<{ revision_id: string; canvas_name: string | null }[]>(
    token,
    'artifacts?role=eq.render&select=revision_id,canvas_name',
  )

  /**
   * Inspirations, per kit, listed from storage.
   *
   * Files rather than rows, so there is no table to select from. The prefix rule is
   * applied here as well as at attach time: a file only belongs to a kit if its name
   * begins with that brand's slug. Enforcing it in the picker too means an operator is
   * never offered something the launcher would then refuse — a choice that silently
   * does nothing is worse than one that was never offered.
   */
  const inspirations: Record<string, string[]> = {}
  for (const kit of kits) {
    const slugs = [
      customerId.toLowerCase(),
      kit.id.toLowerCase().replace(/^bk-/, '').replace(/-\d{4}$/, ''),
    ]
    const objects = await listObjects(token, 'brains', `${kit.id}/inspirations/`)
    inspirations[kit.id] = objects
      .map((o) => o.name)
      .filter((name) => {
        const lower = name.toLowerCase()
        return slugs.some((s) => lower.startsWith(`${s}-`) || lower.startsWith(`${s}_`))
      })
  }

  return (
    <IntakeClient
      customerId={customerId}
      kits={kits}
      sources={{
        assets,
        fonts,
        findings,
        inspirations,
        templates: requests.map((t) => ({
          id: t.id,
          kitId: t.kit_id,
          campaign: t.campaign_name,
          headline: t.copy?.headline ?? null,
          subhead: t.copy?.subhead ?? null,
          eyebrow: t.copy?.eyebrow ?? null,
          cta: t.copy?.cta ?? null,
          plateDirection: t.plate_direction,
          canvases: t.request_canvases.map((c) => c.name),
        })),
        pastWork: approved.map((r) => {
          const request = requests.find((t) => t.id === r.request_id)
          return {
            revisionId: r.id,
            n: r.n,
            kitId: request?.kit_id ?? '',
            campaign: request?.campaign_name ?? 'unknown',
            approvedAt: r.approved_at,
            canvases: [
              ...new Set(
                renders
                  .filter((a) => a.revision_id === r.id && a.canvas_name)
                  .map((a) => a.canvas_name as string),
              ),
            ],
          }
        }),
      }}
    />
  )
}

export const dynamic = 'force-dynamic'
