import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  availableInspirations,
  blockers,
  discoverCampaigns,
  findings,
  loadCampaign,
  validateCampaign,
} from '../src/campaign'
import { brains, PACKET } from './fixtures'

/**
 * Campaigns are invented, so the only way they earn trust is by being validated
 * before a run spends anything. Every blocked case below would otherwise have
 * been discovered after paying for a plate.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CAMPAIGNS = resolve(here, '..', '..', 'campaigns')
const INSPIRATIONS = PACKET

const all = brains()
const campaigns = discoverCampaigns(CAMPAIGNS)
const temporaries: string[] = []
afterAll(() => {
  for (const d of temporaries) rmSync(d, { recursive: true, force: true })
})

function writeCampaign(patch: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cq-campaign-'))
  temporaries.push(dir)
  const path = join(dir, 'c.json')
  writeFileSync(
    path,
    JSON.stringify({
      id: 'test-campaign',
      brand_kit_id: all[0].kitId,
      campaign: 'Test',
      kind: 'new',
      canvases: [{ name: 'square', width: 1080, height: 1080 }],
      copy: { headline: 'A headline', cta: 'Do the thing' },
      plate_direction: 'A quiet ground with negative space above.',
      inspirations: [],
      ...patch,
    }),
  )
  return path
}

describe('the campaigns in the repo', () => {
  it('there are some to run', () => {
    expect(campaigns.length).toBeGreaterThanOrEqual(2)
  })

  it('covers both brands, because a pipeline that only works for one is not a pipeline', () => {
    const kits = new Set(campaigns.map((c) => c.brandKitId))
    expect(kits.size).toBeGreaterThanOrEqual(2)
    for (const kit of kits) {
      expect(all.some((b) => b.kitId === kit)).toBe(true)
    }
  })

  it('includes an edit, so the revision path has something to exercise', () => {
    expect(campaigns.some((c) => c.kind === 'edit')).toBe(true)
  })

  it.each(campaigns)('$id has nothing blocking it', (campaign) => {
    const issues = validateCampaign(campaign, all, INSPIRATIONS)
    expect(blockers(issues).map((i) => `${i.field}: ${i.detail}`)).toEqual([])
  })

  it('the campaign that asks for the leaderboard reports it as a finding, not a failure', () => {
    const withLeaderboard = campaigns.find((c) =>
      c.canvases.some((k) => k.width === 728 && k.height === 90),
    )
    expect(withLeaderboard, 'one campaign should request all four sizes').toBeDefined()
    if (!withLeaderboard) return

    const issues = validateCampaign(withLeaderboard, all, INSPIRATIONS)
    expect(blockers(issues)).toEqual([])

    const finding = findings(issues).find((i) => i.detail.includes('728x90'))
    expect(finding).toBeDefined()
    expect(finding?.detail).toMatch(/8\.09:1/)
    expect(finding?.detail).toMatch(/other\s+canvases still ship/)
  })

  it('names only inspirations that exist', () => {
    const available = availableInspirations(INSPIRATIONS)
    expect(available.length).toBeGreaterThan(0)
    for (const campaign of campaigns) {
      for (const name of campaign.inspirations) {
        expect(available).toContain(name)
      }
    }
  })

  it('gives every canvas a plate direction to work from', () => {
    for (const campaign of campaigns) {
      expect(campaign.plateDirection?.length ?? 0).toBeGreaterThan(20)
    }
  })
})

describe('a malformed campaign is stopped before it costs anything', () => {
  it('blocks a kit no ingested brand has', () => {
    const issues = validateCampaign(
      loadCampaign(writeCampaign({ brand_kit_id: 'bk-not-a-real-kit-2031' })),
      all,
      INSPIRATIONS,
    )
    const blocked = blockers(issues)
    expect(blocked.length).toBe(1)
    expect(blocked[0].detail).toMatch(/guessing one from the name is how a leak starts/)
  })

  it('blocks an inspiration filename that resolves to nothing', () => {
    // Silently treating a typo as "no reference attached" would change the
    // output without anyone noticing.
    const issues = validateCampaign(
      loadCampaign(writeCampaign({ inspirations: ['kahua-abm-add.png'] })),
      all,
      INSPIRATIONS,
    )
    expect(blockers(issues).some((i) => i.field === 'inspirations')).toBe(true)
  })

  it('blocks a missing headline or CTA', () => {
    expect(
      blockers(
        validateCampaign(
          loadCampaign(writeCampaign({ copy: { headline: '', cta: 'Go' } })),
          all,
          INSPIRATIONS,
        ),
      ).some((i) => i.field === 'copy.headline'),
    ).toBe(true)

    expect(
      blockers(
        validateCampaign(
          loadCampaign(writeCampaign({ copy: { headline: 'H' } })),
          all,
          INSPIRATIONS,
        ),
      ).some((i) => i.field === 'copy.cta'),
    ).toBe(true)
  })

  it('blocks whitespace masquerading as copy', () => {
    const issues = validateCampaign(
      loadCampaign(writeCampaign({ copy: { headline: 'H', cta: 'C', subhead: '   ' } })),
      all,
      INSPIRATIONS,
    )
    expect(blockers(issues).some((i) => i.field === 'copy.subhead')).toBe(true)
  })

  it('blocks no canvases, and a duplicated canvas name', () => {
    expect(
      blockers(validateCampaign(loadCampaign(writeCampaign({ canvases: [] })), all, INSPIRATIONS))
        .some((i) => i.field === 'canvases'),
    ).toBe(true)

    const dup = writeCampaign({
      canvases: [
        { name: 'square', width: 1080, height: 1080 },
        { name: 'square', width: 1080, height: 1350 },
      ],
    })
    expect(
      blockers(validateCampaign(loadCampaign(dup), all, INSPIRATIONS))
        .some((i) => i.detail.includes('twice')),
    ).toBe(true)
  })

  it('blocks a nonsensical canvas size', () => {
    const issues = validateCampaign(
      loadCampaign(writeCampaign({ canvases: [{ name: 'square', width: 0, height: 1080 }] })),
      all,
      INSPIRATIONS,
    )
    expect(blockers(issues).some((i) => i.detail.includes('nonsensical'))).toBe(true)
  })

  it('blocks an edit that names no parent', () => {
    const issues = validateCampaign(
      loadCampaign(writeCampaign({ kind: 'edit', of_campaign: '' })),
      all,
      INSPIRATIONS,
    )
    expect(blockers(issues).some((i) => i.field === 'of_campaign')).toBe(true)
  })

  it('flags an edit with no operator message, without blocking it', () => {
    const issues = validateCampaign(
      loadCampaign(writeCampaign({ kind: 'edit', of_campaign: 'something', messages: [] })),
      all,
      INSPIRATIONS,
    )
    expect(blockers(issues)).toEqual([])
    expect(findings(issues).some((i) => i.field === 'messages')).toBe(true)
  })

  it('flags a missing plate direction, without blocking it', () => {
    const issues = validateCampaign(
      loadCampaign(writeCampaign({ plate_direction: '' })),
      all,
      INSPIRATIONS,
    )
    expect(blockers(issues)).toEqual([])
    expect(findings(issues).some((i) => i.field === 'plate_direction')).toBe(true)
  })
})
