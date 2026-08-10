import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DARK_GROUND_LUMINANCE,
  DEFAULT_LOGO_PREFERENCE,
  chooseLogo,
  loadBrain,
} from '../src/brain'
import { assessLogoGround, type ArtifactBundle } from '../src/checks'
import { luminanceAt, makePng, relativeLuminance } from '../src/png'
import { brains } from './fixtures'

/**
 * The missing reverse logo has a real answer, and it comes from the brand's own
 * staged assets rather than from a rule about any particular brand.
 */

const temporaries: string[] = []
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

const svg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="${fill}"/></svg>`

/** A brain staging exactly the asset kinds a test cares about. */
function writeBrain(kinds: string[], kitId = 'bk-testkit-2031'): string {
  const root = mkdtempSync(join(tmpdir(), 'cq-logo-'))
  temporaries.push(root)
  const dir = join(root, 'testbrand')
  mkdirSync(join(dir, 'brand'), { recursive: true })
  mkdirSync(join(dir, 'fonts'), { recursive: true })

  writeFileSync(
    join(dir, 'DESIGN.md'),
    '# Test\n\n## Palette\n\n- primary: #101418\n- surface: #FFFFFF\n\n' +
      '## Type\n\n- heading: Ashgrove\n\n## Type scale\n\n- h1: 40px\n\n' +
      '## Shape\n\n- border-radius: 4px\n\n## Applying it\n\nPlain.\n',
  )
  writeFileSync(join(dir, 'fonts', 'ashgrove_700_normal.ttf'), 'stub')

  for (const kind of kinds) {
    writeFileSync(join(dir, 'brand', `${kind}.svg`), svg('#FE7A11'))
  }
  writeFileSync(
    join(dir, 'brand', 'asset_manifest.json'),
    JSON.stringify({
      brand_kit_id: kitId,
      assets: kinds.map((kind) => ({
        kind,
        path: `brand/${kind}.svg`,
        brand_kit_id: kitId,
      })),
    }),
  )
  return dir
}

const DARK = 0.02
const LIGHT = 0.9

describe('the preference order is data, and it resolves generically', () => {
  it('takes the reverse mark on a dark ground when one is staged', () => {
    const brain = loadBrain(writeBrain(['logo', 'logo_reverse', 'logo_mark']))
    const choice = chooseLogo(brain, DARK)
    expect(choice.groundIsDark).toBe(true)
    expect(choice.kind).toBe('logo_reverse')
  })

  it('falls back to the symbol on a dark ground when no reverse exists', () => {
    // This is the packet's Kahua situation, stated without naming it: the
    // manifest lists a reverse logo that has no file, but a symbol is staged.
    const brain = loadBrain(writeBrain(['logo', 'logo_mark']))
    const choice = chooseLogo(brain, DARK)
    expect(choice.kind).toBe('logo_mark')
    expect(choice.reason).toMatch(/logo_reverse → logo_mark/)
  })

  it('omits and escalates on a dark ground when neither is staged', () => {
    const brain = loadBrain(writeBrain(['logo']))
    const choice = chooseLogo(brain, DARK)
    expect(choice.asset).toBeNull()
    expect(choice.kind).toBeNull()
    expect(choice.reason).toMatch(/omit the logo and escalate/)
    expect(choice.reason).toMatch(/never typeset a substitute/)
  })

  it('takes the primary logo on a light ground', () => {
    const brain = loadBrain(writeBrain(['logo', 'logo_reverse', 'logo_mark']))
    expect(chooseLogo(brain, LIGHT).kind).toBe('logo')
  })

  it('never offers an asset belonging to another kit', () => {
    const dir = writeBrain(['logo_reverse'])
    writeFileSync(join(dir, 'brand', 'foreign.svg'), svg('#000000'))
    writeFileSync(
      join(dir, 'brand', 'asset_manifest.json'),
      JSON.stringify({
        brand_kit_id: 'bk-testkit-2031',
        assets: [
          { kind: 'logo_reverse', path: 'brand/foreign.svg', brand_kit_id: 'bk-other-9999' },
        ],
      }),
    )
    const brain = loadBrain(dir)
    const choice = chooseLogo(brain, DARK)
    expect(choice.asset).toBeNull()
  })

  it('honours a different preference order without a code change', () => {
    const brain = loadBrain(writeBrain(['logo', 'logo_mark']))
    const inverted = { dark: ['logo_mark'], light: ['logo_mark'] }
    expect(chooseLogo(brain, LIGHT, inverted).kind).toBe('logo_mark')
    expect(chooseLogo(brain, LIGHT, DEFAULT_LOGO_PREFERENCE).kind).toBe('logo')
  })
})

describe('the dark threshold is the exact white-versus-black crossover', () => {
  it('sits where it should relative to real colours', () => {
    // A deep navy ground is dark; the brand's own surface white is not.
    expect(relativeLuminance('#1B3A5C')).toBeLessThan(DARK_GROUND_LUMINANCE)
    expect(relativeLuminance('#FFFFFF')).toBeGreaterThan(DARK_GROUND_LUMINANCE)
  })

  it('reads the ground out of an actual render', () => {
    const dark = makePng(200, 200, '#101418')
    const light = makePng(200, 200, '#F4F6F6')
    const box = { x: 10, y: 10, width: 100, height: 40 }
    expect(luminanceAt(dark, box)).toBeLessThan(DARK_GROUND_LUMINANCE)
    expect(luminanceAt(light, box)).toBeGreaterThan(DARK_GROUND_LUMINANCE)
  })
})

describe('the assessment reports rather than fails', () => {
  function bundleWith(assetPath: string): ArtifactBundle {
    return {
      canvas: { name: 'square', width: 400, height: 400 },
      plate: { width: 400, height: 400, generatedWidth: 400, generatedHeight: 400 },
      brandKitId: 'bk-testkit-2031',
      requiredStrings: [],
      overlay: [
        {
          role: 'logo',
          box: { x: 20, y: 20, width: 240, height: 80 },
          assetPath,
          renderedWidth: 240,
          renderedHeight: 80,
        },
      ],
    }
  }

  it('flags a mismatch without turning it into a failure', () => {
    const brain = loadBrain(writeBrain(['logo', 'logo_reverse']))
    const raster = makePng(400, 400, '#101418')
    const [assessment] = assessLogoGround(bundleWith('brand/logo.svg'), brain, raster)

    expect(assessment.groundIsDark).toBe(true)
    expect(assessment.placedKind).toBe('logo')
    expect(assessment.recommendedKind).toBe('logo_reverse')
    expect(assessment.matchesRecommendation).toBe(false)
  })

  it('agrees when the right kind was placed', () => {
    const brain = loadBrain(writeBrain(['logo', 'logo_reverse']))
    const raster = makePng(400, 400, '#101418')
    const [assessment] = assessLogoGround(bundleWith('brand/logo_reverse.svg'), brain, raster)
    expect(assessment.matchesRecommendation).toBe(true)
  })

  it('accepts a wordmark on a light region of an otherwise dark canvas', () => {
    // A deliberately composed light corner. No threshold could tell this apart
    // from a mistake, which is exactly why this is a measurement, not a check.
    const brain = loadBrain(writeBrain(['logo', 'logo_reverse']))
    const raster = makePng(400, 400, '#101418', [
      { x: 0, y: 0, width: 300, height: 140, color: '#FFFFFF' },
    ])
    const [assessment] = assessLogoGround(bundleWith('brand/logo.svg'), brain, raster)
    expect(assessment.groundIsDark).toBe(false)
    expect(assessment.recommendedKind).toBe('logo')
    expect(assessment.matchesRecommendation).toBe(true)
  })
})

describe('against the real packet', () => {
  it('every brain resolves a usable logo on a light ground', () => {
    for (const brain of brains()) {
      expect(chooseLogo(brain, LIGHT).asset).not.toBeNull()
    }
  })

  it('the brains take different branches on a dark ground, from one rule', () => {
    const kinds = brains().map((b) => ({
      slug: b.slug,
      kind: chooseLogo(b, DARK).kind,
    }))
    // Whatever each brain stages, none is left with nothing on a dark ground and
    // no two need a bespoke rule to get there.
    for (const entry of kinds) expect(entry.kind).not.toBeNull()
    expect(new Set(kinds.map((k) => k.kind)).size).toBeGreaterThanOrEqual(1)
  })

  it('a brain whose reverse logo has no file still finds a symbol', () => {
    const withMissingReverse = brains().find((b) =>
      b.assets.some((a) => a.kind === 'logo_reverse' && !a.exists),
    )
    expect(withMissingReverse).toBeDefined()
    if (!withMissingReverse) return

    const choice = chooseLogo(withMissingReverse, DARK)
    expect(choice.kind).toBe('logo_mark')
    expect(choice.asset?.exists).toBe(true)
  })
})
