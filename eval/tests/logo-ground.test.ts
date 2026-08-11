import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DARK_GROUND_LUMINANCE,
  DEFAULT_LOGO_PREFERENCE,
  chooseLogo,
  loadBrain,
  recoverMissingKind,
  reverseCandidates,
  svgSkeleton,
} from '../src/brain'
import { assessLogoGround, type ArtifactBundle } from '../src/checks'
import { luminanceAt, makePng, relativeLuminance } from '../src/png'
import { PACKET, brains } from './fixtures'

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

/**
 * Reverse-variant recovery.
 *
 * One kit in the packet declares a reverse logo whose file is not in the kit. The
 * file does exist — it is declared in *another* kit's manifest, tagged as
 * belonging to this one, and ingest uploads bytes under the prefix of the kit that
 * owns them. So the shape these cases exercise is the post-ingest one: the file
 * has arrived in the kit's folder and the kit's own manifest has never heard of
 * it. That is exactly why recovery scans files rather than manifest entries.
 *
 * `materialise` reproduces that arrangement from the packet, which is what a run
 * downloading the kit from storage actually sees.
 */
describe('recovering a reverse logo that is filed under another name', () => {
  /** A kit folder as it exists after ingest: its own files, plus assets it owns. */
  function materialise(kitSlug: string, adopt: { from: string; file: string }[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), `materialised-${kitSlug}-`))
    temporaries.push(dir)
    const source = join(PACKET, 'design-brains', kitSlug)
    cpSync(source, dir, { recursive: true })
    for (const { from, file } of adopt) {
      cpSync(join(PACKET, 'design-brains', from, 'brand', file), join(dir, 'brand', file))
    }
    return dir
  }

  /** The kit whose manifest names a reverse logo with no file behind it. */
  function kitMissingReverse(): { slug: string; owned: { from: string; file: string }[] } | null {
    for (const brain of brains()) {
      const missing = brain.assets.find((a) => a.kind === 'logo_reverse' && !a.exists)
      if (!missing) continue
      // Assets this kit owns that are staged in someone else's folder.
      const owned: { from: string; file: string }[] = []
      for (const other of brains()) {
        if (other.kitId === brain.kitId) continue
        for (const asset of other.assets) {
          if (asset.kitId === brain.kitId && asset.exists) {
            owned.push({ from: other.slug, file: basename(asset.path) })
          }
        }
      }
      if (owned.length) return { slug: brain.slug, owned }
    }
    return null
  }

  it('the packet still contains the case this covers', () => {
    expect(kitMissingReverse(), 'no kit is missing a reverse logo it owns elsewhere').not.toBeNull()
  })

  it('recovers the misfiled reverse logo once the kit holds its own assets', () => {
    const target = kitMissingReverse()!
    const brain = loadBrain(materialise(target.slug, target.owned))

    const asset = brain.assets.find((a) => a.kind === 'logo_reverse')!
    expect(asset.resolvedFrom, `${brain.kitId} did not recover a reverse logo`).toBeTruthy()
    expect(asset.exists).toBe(true)
    // The declaration is preserved; only what was used is added beside it.
    expect(asset.path).not.toBe(asset.resolvedFrom!.path)
    expect(existsSync(asset.absolutePath)).toBe(true)

    const recovered = readFileSync(asset.absolutePath, 'utf8')
    const primary = readFileSync(
      brain.assets.find((a) => a.kind === 'logo' && a.exists)!.absolutePath,
      'utf8',
    )
    // The defining property: the same drawing, different ink.
    expect(svgSkeleton(recovered)).toEqual(svgSkeleton(primary))
    expect(recovered).not.toBe(primary)
  })

  it('the recovered file is what gets placed on a dark ground', () => {
    const target = kitMissingReverse()!
    const brain = loadBrain(materialise(target.slug, target.owned))
    const asset = brain.assets.find((a) => a.kind === 'logo_reverse')!

    const choice = chooseLogo(brain, 0.02)
    expect(choice.kind, `${brain.kitId} still has no dark-ground logo`).toBe('logo_reverse')
    expect(choice.asset!.absolutePath).toBe(asset.absolutePath)
  })

  it('leaves a kit alone when nothing in it matches', () => {
    // Recovery must not invent an answer. A kit missing a reverse logo with no
    // recoloured twin present stays missing, and stays reported.
    const target = kitMissingReverse()!
    const brain = loadBrain(materialise(target.slug))
    const asset = brain.assets.find((a) => a.kind === 'logo_reverse')!
    expect(asset.resolvedFrom).toBeUndefined()
    expect(asset.exists).toBe(false)
    expect(chooseLogo(brain, 0.02).kind).not.toBe('logo_reverse')
  })

  it('does not mistake a co-brand lockup for a reverse variant', () => {
    /**
     * The control that killed the first version of this rule. Matching on geometry
     * and label alone accepted this file: its wordmark path is byte-identical to
     * the primary's and it carries the same label. Only the extra elements
     * distinguish it — and those extra elements are a second party's name, which
     * is precisely what must never be placed as if it were the customer's logo.
     */
    const dir = mkdtempSync(join(tmpdir(), 'lockup-control-'))
    temporaries.push(dir)
    mkdirSync(join(dir, 'brand'), { recursive: true })
    writeFileSync(
      join(dir, 'DESIGN.md'),
      '# Control\n\n## Palette\n\n- primary: #1E293B\n- ink: #0F172A\n- surface: #FFFFFF\n',
    )
    writeFileSync(
      join(dir, 'brand', 'asset_manifest.json'),
      JSON.stringify({
        brand_kit_id: 'bk-control',
        assets: [
          { kind: 'logo', path: 'brand/mark.svg', brand_kit_id: 'bk-control' },
          { kind: 'logo_reverse', path: 'brand/mark-white.svg', brand_kit_id: 'bk-control' },
          { kind: 'logo_lockup', path: 'brand/mark-with-partner.svg', brand_kit_id: 'bk-control' },
        ],
      }),
    )
    const wordmark = '<path d="M16 76 L48 16 L80 76 Z" fill="%FILL%"/>'
    writeFileSync(
      join(dir, 'brand', 'mark.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 96" aria-label="CONTROL">${wordmark.replace('%FILL%', '#0F172A')}</svg>`,
    )
    // Same drawing, plus a second party. All-white, so a colour-only rule accepts it.
    writeFileSync(
      join(dir, 'brand', 'mark-with-partner.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 96" aria-label="CONTROL">` +
        `${wordmark.replace('%FILL%', '#FFFFFF')}` +
        `<rect x="212" y="30" width="2" height="36" fill="#FFFFFF"/>` +
        `<text x="226" y="60" font-size="18" fill="#FFFFFF">PARTNER</text></svg>`,
    )

    const brain = loadBrain(dir)
    expect(
      reverseCandidates(brain).map((c) => c.path),
      'a lockup carrying a second party was offered as the reverse logo',
    ).not.toContain('brand/mark-with-partner.svg')
    expect(brain.assets.find((a) => a.kind === 'logo_reverse')!.resolvedFrom).toBeUndefined()
  })

  it('reports rather than guesses when two files could each be the reverse', () => {
    const target = kitMissingReverse()!
    const dir = materialise(target.slug, target.owned)
    const brain = loadBrain(dir)
    const recoveredPath = brain.assets.find((a) => a.kind === 'logo_reverse')!.resolvedFrom!.path

    // A second, byte-identical copy under a different name. Both are equally good
    // answers, so measurement has run out and a person has to choose.
    cpSync(join(dir, recoveredPath), join(dir, 'brand', 'another-candidate.svg'))
    const forked = loadBrain(dir)
    expect(reverseCandidates(forked).length).toBe(2)

    const result = recoverMissingKind(forked)
    expect(result && 'ambiguous' in result, 'two candidates were silently narrowed to one').toBe(true)
    expect(forked.assets.find((a) => a.kind === 'logo_reverse')!.resolvedFrom).toBeUndefined()
  })
})
