import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Brain } from './brain'
import { GPT_IMAGE_2, planGeneration, type Envelope } from './capability'

/**
 * Campaigns are made up, and they live in `campaigns/` as JSON.
 *
 * **Local test fixtures only.** Nothing in that directory is product data and
 * nothing in it ships. In the running system a campaign arrives from an operator
 * through the composer and lands in Postgres; these files stand in for that while
 * the composer does not exist.
 *
 * The brief says to invent them — *"Make the campaign up — the Long Island
 * Railroad, whatever."* So a campaign file is a local stand-in for what an
 * operator submits, and validating one before a run starts is the cheapest place
 * to catch a mistake: an unresolvable kit or a misspelled inspiration filename
 * would otherwise be discovered after paying for a plate.
 *
 * The shape is ours. The packet's example payloads are explicitly *"not a
 * schema"*, so this resembles them only where resembling them is useful.
 */

export interface CampaignCanvas {
  name: string
  width: number
  height: number
}

export interface CampaignCopy {
  eyebrow?: string | null
  headline: string
  subhead?: string | null
  cta: string
  cta_href?: string | null
  legal?: string | null
}

export interface Campaign {
  id: string
  brandKitId: string
  campaign: string
  kind: 'new' | 'edit'
  canvases: CampaignCanvas[]
  copy: CampaignCopy
  /** The human's intent for the imagery. Becomes the seed of the plate prompt. */
  plateDirection?: string
  /** Exact filenames from the inspirations directory. Empty means none attached. */
  inspirations: string[]
  /** Operator feedback, on an edit. */
  messages?: string[]
  ofCampaign?: string
  ofRevision?: number
  notes?: string
  /**
   * Layout intent a person read out of `DESIGN.md`: where copy sits, whether the
   * CTA is filled or outlined, which weights carry which role. Pinned here so
   * Gate 0 is deterministic. In the running system the agent reads that prose
   * itself, which is why none of it lives in code.
   */
  style?: unknown
  sourcePath: string
}

export interface CampaignIssue {
  field: string
  severity: 'blocked' | 'review'
  detail: string
}

export function loadCampaign(path: string): Campaign {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return {
    id: raw.id ?? '',
    brandKitId: raw.brand_kit_id ?? '',
    campaign: raw.campaign ?? '',
    kind: raw.kind === 'edit' ? 'edit' : 'new',
    canvases: Array.isArray(raw.canvases) ? raw.canvases : [],
    copy: raw.copy ?? {},
    plateDirection: raw.plate_direction,
    inspirations: Array.isArray(raw.inspirations) ? raw.inspirations : [],
    messages: raw.messages,
    ofCampaign: raw.of_campaign,
    ofRevision: raw.of_revision,
    notes: raw.notes,
    style: raw.style,
    sourcePath: path,
  }
}

export function discoverCampaigns(dir: string): Campaign[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadCampaign(join(dir, f)))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Filenames available to attach, discovered rather than listed. */
export function availableInspirations(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(png|jpe?g|webp)$/i.test(name)) out.push(name)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * Everything wrong with a campaign, before a run is created.
 *
 * `blocked` stops it. `review` is surfaced and continues — an impossible canvas
 * is the brief's own instruction: *"that's a finding — say so, rather than letting
 * the request fail at run time."*
 */
export function validateCampaign(
  campaign: Campaign,
  brains: Brain[],
  inspirationsRoot: string,
  env: Envelope = GPT_IMAGE_2,
): CampaignIssue[] {
  const issues: CampaignIssue[] = []
  const block = (field: string, detail: string) =>
    issues.push({ field, severity: 'blocked', detail })
  const review = (field: string, detail: string) =>
    issues.push({ field, severity: 'review', detail })

  if (!campaign.id.trim()) block('id', 'a campaign needs an id')

  const brain = brains.find((b) => b.kitId === campaign.brandKitId)
  if (!campaign.brandKitId.trim()) {
    block('brand_kit_id', 'no brand kit named')
  } else if (!brain) {
    block(
      'brand_kit_id',
      `no ingested brand has kit "${campaign.brandKitId}" — a campaign cannot pin a kit ` +
        'that does not exist, and guessing one from the name is how a leak starts',
    )
  }

  if (campaign.canvases.length === 0) block('canvases', 'no canvases requested')

  const seen = new Set<string>()
  for (const canvas of campaign.canvases) {
    if (seen.has(canvas.name)) {
      block('canvases', `canvas name "${canvas.name}" appears twice`)
    }
    seen.add(canvas.name)

    if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) ||
        canvas.width < 1 || canvas.height < 1) {
      block('canvases', `${canvas.name} has a nonsensical size`)
      continue
    }

    const plan = planGeneration(canvas.width, canvas.height, env)
    if (!plan.ok) {
      review(
        'canvases',
        `${canvas.name} ${canvas.width}x${canvas.height} cannot be produced by ` +
          `${env.name}: ${plan.reasons.join('; ')}. Reported as a finding; the other ` +
          'canvases still ship.',
      )
    } else if (!plan.aspectExact) {
      review(
        'canvases',
        `${canvas.name} has no aspect-exact legal size; generating at ` +
          `${plan.generateWidth}x${plan.generateHeight} leaves ` +
          `${(plan.anisotropy * 100).toFixed(4)}% anisotropy`,
      )
    }
  }

  if (!campaign.copy?.headline?.trim()) block('copy.headline', 'a headline is required')
  if (!campaign.copy?.cta?.trim()) block('copy.cta', 'a CTA label is required')
  for (const [key, value] of Object.entries(campaign.copy ?? {})) {
    if (typeof value === 'string' && value.length > 0 && !value.trim()) {
      block(`copy.${key}`, 'whitespace is not copy')
    }
  }

  // SKILL.md: an inspiration is consulted only when the request attaches it by
  // filename. A name that resolves to nothing would silently mean "no reference".
  const available = availableInspirations(inspirationsRoot)
  for (const name of campaign.inspirations) {
    if (!available.includes(name)) {
      block(
        'inspirations',
        `"${name}" is not in the inspirations directory. Available: ${available.join(', ')}`,
      )
    }
  }

  if (!campaign.plateDirection?.trim()) {
    review(
      'plate_direction',
      'no plate direction given; the agent can still write a prompt, but composition, ' +
        'lighting and negative space are what the brand actually cares about',
    )
  }

  if (campaign.kind === 'edit') {
    if (!campaign.ofCampaign?.trim()) {
      block('of_campaign', 'an edit must name the campaign it revises')
    }
    if (!campaign.messages || campaign.messages.length === 0) {
      review('messages', 'an edit with no operator message has nothing to act on')
    }
  }

  return issues
}

export const blockers = (issues: CampaignIssue[]): CampaignIssue[] =>
  issues.filter((i) => i.severity === 'blocked')

export const findings = (issues: CampaignIssue[]): CampaignIssue[] =>
  issues.filter((i) => i.severity === 'review')
