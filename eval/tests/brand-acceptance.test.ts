import { describe, expect, it } from 'vitest'
import {
  chooseLogo,
  loadBrain,
  resolveFamily,
  resolveScaleValue,
  selfContradictions,
  type Brain,
} from '../src/brain'
import { GPT_IMAGE_2, planGeneration } from '../src/capability'
import { availableAssets, planIngest } from '../src/ingest'
import { brains } from './fixtures'

/**
 * Acceptance tests for the two brands we actually have. **Hardcoded on purpose.**
 *
 * The main suite derives every expectation from the brain, which proves the
 * *mechanism* is brand-agnostic. It cannot prove the *outcome* is right: generic
 * code can resolve a value with complete confidence and be wrong, and every
 * derived assertion would still pass.
 *
 * So these tests state the answers out loud. If the resolution logic drifts, a
 * number here changes and the failure names the exact value.
 *
 * Hardcoding is safe in this file and nowhere else: the tenant-name scanner reads
 * `app/`, `api/` and `src/`, never `tests/`. Product code stays brand-blind.
 */

const byKit = (kitId: string): Brain => {
  const found = brains().find((b) => b.kitId === kitId)
  if (!found) throw new Error(`no brain in the packet with kit ${kitId}`)
  return found
}

const DARK = 0.02
const LIGHT = 0.9

describe('bk-kahua-2026 resolves to exactly these values', () => {
  const brain = byKit('bk-kahua-2026')

  it('has this palette, and no secondary', () => {
    expect(brain.palette).toEqual({
      primary: '#1B3A5C',
      accent: '#F26B21',
      surface: '#FFFFFF',
      ink: '#16202B',
      muted: '#6B7A88',
    })
    expect(brain.palette.secondary).toBeUndefined()
  })

  it('has a 4px radius', () => {
    expect(brain.shape['border-radius']).toBe('4px')
  })

  it('resolves h1 to 48px, against its own table', () => {
    // The table says 56px, the prose says 48px on every canvas, and the cache
    // agrees with the table. The prose is as binding as the numbers and is the
    // more specific statement, so 48px — recorded, and repeatable.
    expect(brain.typeScale.h1).toBe('56px')
    const h1 = resolveScaleValue(brain, 'h1')
    expect(h1?.value).toBe('48px')
    expect(h1?.source).toBe('prose')
    expect(h1?.contested).toBe(true)
  })

  it('leaves the uncontested scale values alone', () => {
    expect(resolveScaleValue(brain, 'h2')?.value).toBe('36px')
    expect(resolveScaleValue(brain, 'h3')?.value).toBe('24px')
    expect(resolveScaleValue(brain, 'body')?.value).toBe('17px')
    expect(resolveScaleValue(brain, 'caption')?.value).toBe('14px')
    for (const key of ['h2', 'h3', 'body', 'caption']) {
      expect(resolveScaleValue(brain, key)?.contested).toBe(false)
    }
  })

  it('names a condensed heading face it does not ship, and substitutes Barlow 700', () => {
    expect(brain.type.heading).toBe('Barlow Condensed')
    expect(brain.type.body).toBe('Barlow')
    expect(brain.fonts.map((f) => f.file).sort()).toEqual([
      'barlow_400_normal.ttf',
      'barlow_500_normal.ttf',
      'barlow_600_normal.ttf',
      'barlow_700_normal.ttf',
    ])

    const heading = resolveFamily(brain, 'Barlow Condensed')
    expect(heading.resolvedFamilySlug).toBe('barlow')
    expect(heading.weight).toBe(700)
    expect(heading.substituted).toBe(true)

    const body = resolveFamily(brain, 'Barlow')
    expect(body.resolvedFamilySlug).toBe('barlow')
    expect(body.substituted).toBe(false)
  })

  it('lists a reverse logo it does not have, and offers the mark on a dark ground', () => {
    const reverse = brain.assets.find((a) => a.kind === 'logo_reverse')
    expect(reverse?.path).toBe('brand/kahua-logo-white.svg')
    expect(reverse?.exists).toBe(false)

    expect(chooseLogo(brain, DARK).kind).toBe('logo_mark')
    expect(chooseLogo(brain, DARK).asset?.path).toBe('brand/kahua-mark.svg')
    expect(chooseLogo(brain, LIGHT).kind).toBe('logo')
    expect(chooseLogo(brain, LIGHT).asset?.path).toBe('brand/kahua-logo.svg')
  })

  it('stages three asset kinds and no lockup', () => {
    expect(brain.assets.map((a) => a.kind)).toEqual(['logo', 'logo_reverse', 'logo_mark'])
    expect(brain.assets.every((a) => a.kitId === 'bk-kahua-2026')).toBe(true)
  })

  it('produces exactly these ingest findings', () => {
    const codes = planIngest(brain.dir).findings.map((f) => f.code).sort()
    expect(codes).toContain('design-doc-self-conflict')
    expect(codes).toContain('font-substituted')
    expect(codes).toContain('asset-missing-file')
    // Its token cache agrees with DESIGN.md on every value, so there is nothing
    // to reconcile — unlike the other brand in this packet.
    expect(codes).not.toContain('token-cache-conflict')
    expect(codes).not.toContain('asset-foreign-kit')
  })

  it('has one self-contradiction, and it is h1', () => {
    const found = selfContradictions(brain)
    expect(found.length).toBe(1)
    expect(found[0].key).toBe('h1')
    expect(found[0].value).toBe('48px')
  })
})

describe('bk-emplifi-2026 resolves to exactly these values', () => {
  const brain = byKit('bk-emplifi-2026')

  it('has this palette, including a secondary the other brand lacks', () => {
    expect(brain.palette).toEqual({
      primary: '#0C3B5D',
      secondary: '#6765FE',
      accent: '#FF5A21',
      surface: '#FFFFFF',
      ink: '#111113',
      muted: '#94A9B8',
    })
  })

  it('takes DESIGN.md over the token cache on all three disagreements', () => {
    // The cache says #5B5BD6, 16px and 56px. It is also the newer file, which is
    // the trap. It has no authority and is never hydrated.
    expect(brain.palette.secondary).toBe('#6765FE')
    expect(brain.shape['border-radius']).toBe('12px')
    expect(brain.typeScale.h1).toBe('48px')
  })

  it('resolves h1 to 48px with nothing contested', () => {
    const h1 = resolveScaleValue(brain, 'h1')
    expect(h1?.value).toBe('48px')
    expect(h1?.source).toBe('table')
    expect(h1?.contested).toBe(false)
    expect(selfContradictions(brain)).toEqual([])
  })

  it('ships every family it names, so nothing is substituted', () => {
    expect(brain.type.heading).toBe('Inter')
    expect(brain.type.body).toBe('Inter')
    expect(brain.fonts.map((f) => f.file).sort()).toEqual([
      'inter_400_normal.ttf',
      'inter_500_normal.ttf',
      'inter_600_normal.ttf',
      'inter_700_normal.ttf',
    ])
    expect(resolveFamily(brain, 'Inter').substituted).toBe(false)
    expect(resolveFamily(brain, 'Inter').weight).toBe(700)
  })

  it('has a real reverse logo, so a dark ground takes it', () => {
    expect(chooseLogo(brain, DARK).kind).toBe('logo_reverse')
    expect(chooseLogo(brain, DARK).asset?.path).toBe('brand/emplifi-logo-white.svg')
    expect(chooseLogo(brain, LIGHT).asset?.path).toBe('brand/emplifi-logo.svg')
  })

  it('carries a lockup belonging to the other kit, and never offers it', () => {
    const lockup = brain.assets.find((a) => a.kind === 'logo_lockup')
    expect(lockup?.path).toBe('brand/partner-lockup.svg')
    expect(lockup?.kitId).toBe('bk-kahua-2026')
    expect(lockup?.exists).toBe(true)

    const offered = availableAssets(planIngest(brain.dir)).map((a) => a.manifestPath)
    expect(offered).not.toContain('brand/partner-lockup.svg')
    expect(offered.sort()).toEqual([
      'brand/emplifi-logo-white.svg',
      'brand/emplifi-logo.svg',
      'brand/emplifi-mark.svg',
    ])
  })

  it('produces exactly these ingest findings', () => {
    const findings = planIngest(brain.dir).findings
    const codes = findings.map((f) => f.code)
    expect(codes.filter((c) => c === 'token-cache-conflict').length).toBe(3)
    expect(codes).toContain('asset-foreign-kit')
    expect(codes).not.toContain('font-substituted')
    expect(codes).not.toContain('asset-missing-file')
    expect(codes).not.toContain('design-doc-self-conflict')
  })
})

describe('the four requested canvases plan to exactly these sizes', () => {
  const cases = [
    { name: 'square', w: 1080, h: 1080, gen: [1088, 1088], exact: true },
    { name: 'portrait', w: 1080, h: 1350, gen: [1088, 1360], exact: true },
    { name: 'landscape', w: 1200, h: 628, gen: [3088, 1616], exact: false },
  ] as const

  it.each(cases)('$name $w x $h generates at $gen', ({ w, h, gen, exact }) => {
    const plan = planGeneration(w, h, GPT_IMAGE_2)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect([plan.generateWidth, plan.generateHeight]).toEqual([...gen])
    expect(plan.aspectExact).toBe(exact)
    if (exact) expect(plan.anisotropy).toBe(0)
  })

  it('landscape carries 0.0033% anisotropy and no more', () => {
    const plan = planGeneration(1200, 628, GPT_IMAGE_2)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // 157 is prime, so an exact match needs 4800x2512 and breaches the edge cap.
    expect(plan.anisotropy).toBeGreaterThan(0)
    expect(plan.anisotropy).toBeLessThan(0.0001)
    expect((plan.anisotropy * 100).toFixed(4)).toBe('0.0033')
  })

  it('the leaderboard is refused, on both counts, with the numbers', () => {
    const plan = planGeneration(728, 90, GPT_IMAGE_2)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reasons.join(' ')).toMatch(/8\.09:1/)
    expect(plan.reasons.join(' ')).toMatch(/3:1/)
  })
})
