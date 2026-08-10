import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  loadBrain,
  paletteIsMachineReadable,
  paletteIsPartial,
  resolveScaleValue,
  selfContradictions,
} from '../src/brain'
import {
  checkAssetIntegrity,
  checkPaletteConformance,
  failures,
  measureContrast,
  runAllChecks,
  unverified,
  type ArtifactBundle,
} from '../src/checks'
import { availableAssets, isBlocked, planIngest } from '../src/ingest'
import { colourDistance, contrastRatio, makePng } from '../src/png'
import { brains } from './fixtures'

/**
 * Every case here used to pass silently.
 *
 * A check that cannot run must say so. Reporting `unverifiable` is the whole
 * point: it is the difference between "this is fine" and "nobody looked", and
 * only the first of those is worth a green tick.
 */

const temporaries: string[] = []
afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

interface BrainSpec {
  kitId?: string
  folder?: string
  palette?: Record<string, string>
  type?: Record<string, string>
  scale?: Record<string, string>
  applying?: string
  fonts?: string[]
  assets?: { kind: string; path: string; kitId?: string; svg?: string }[]
}

const SVG_WITH_SIZE = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#123456"/></svg>'
const SVG_VIEWBOX_ONLY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><rect width="200" height="50" fill="#123456"/></svg>'
const SVG_NO_DIMENSIONS = '<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="mark"><rect fill="#123456"/></svg>'

function writeBrain(spec: BrainSpec = {}): string {
  const {
    kitId = 'bk-testkit-2031',
    folder = 'testbrand',
    palette = { primary: '#123456', accent: '#FE7A11', surface: '#FFFFFF', ink: '#101418' },
    type = { heading: 'Ashgrove', body: 'Ashgrove' },
    scale = { h1: '44px', h2: '30px', body: '16px', caption: '12px' },
    applying = 'Plain and operational.',
    fonts = ['ashgrove_400_normal.ttf', 'ashgrove_700_normal.ttf'],
    assets = [{ kind: 'logo', path: 'brand/mark.svg' }],
  } = spec

  const root = mkdtempSync(join(tmpdir(), 'cq-silent-'))
  temporaries.push(root)
  const dir = join(root, folder)
  mkdirSync(join(dir, 'brand'), { recursive: true })
  mkdirSync(join(dir, 'fonts'), { recursive: true })

  const lines = (record: Record<string, string>) =>
    Object.entries(record).map(([k, v]) => `- ${k}: ${v}`).join('\n')

  writeFileSync(
    join(dir, 'DESIGN.md'),
    `# Test - Design Brain\n\n## Palette\n\n${lines(palette)}\n\n` +
      `## Type\n\n${lines(type)}\n\n## Type scale\n\n${lines(scale)}\n\n` +
      `## Shape\n\n- border-radius: 6px\n\n## Applying it\n\n${applying}\n`,
  )

  for (const file of fonts) writeFileSync(join(dir, 'fonts', file), 'stub')
  for (const asset of assets) {
    writeFileSync(join(dir, asset.path), asset.svg ?? SVG_WITH_SIZE)
  }

  writeFileSync(
    join(dir, 'brand', 'asset_manifest.json'),
    JSON.stringify({
      brand_kit_id: kitId,
      assets: assets.map((a) => ({
        kind: a.kind,
        path: a.path,
        brand_kit_id: a.kitId ?? kitId,
      })),
    }),
  )

  return dir
}

/** A minimal bundle placing one logo and one coloured text element. */
function bundleFor(
  brain: ReturnType<typeof loadBrain>,
  opts: { assetPath?: string; declared?: string; renderedWidth?: number } = {},
): ArtifactBundle {
  const asset = brain.assets[0]
  return {
    canvas: { name: 'square', width: 1080, height: 1080 },
    plate: { width: 1080, height: 1080, generatedWidth: 1088, generatedHeight: 1088 },
    brandKitId: brain.kitId,
    requiredStrings: [],
    overlay: [
      {
        role: 'logo',
        box: { x: 40, y: 40, width: 240, height: 80 },
        assetPath: opts.assetPath ?? asset?.path,
        renderedWidth: opts.renderedWidth ?? 240,
        renderedHeight: 80,
      },
      {
        role: 'text',
        box: { x: 40, y: 200, width: 600, height: 100 },
        text: 'Live selectable text',
        fontFamily: brain.fonts[0]?.familySlug,
        declaredColours: opts.declared ? [opts.declared] : undefined,
      },
    ],
  }
}

describe('an SVG with no intrinsic size reports unverifiable, not a silent pass', () => {
  it('flags the logo aspect as unknown rather than skipping it', () => {
    const brain = loadBrain(
      writeBrain({ assets: [{ kind: 'logo', path: 'brand/mark.svg', svg: SVG_NO_DIMENSIONS }] }),
    )
    const findings = checkAssetIntegrity(bundleFor(brain), brain)
    const aspect = findings.find((f) => f.check === 'logo-aspect')

    expect(aspect).toBeDefined()
    expect(aspect?.outcome).toBe('unverifiable')
    expect(aspect?.detail).toMatch(/no width, height or viewBox/)
    // The old behaviour: no logo-aspect finding at all, which read as success.
    expect(failures(findings)).toEqual([])
    expect(unverified(findings).length).toBeGreaterThan(0)
  })

  it('still verifies aspect when only a viewBox is declared', () => {
    const brain = loadBrain(
      writeBrain({ assets: [{ kind: 'logo', path: 'brand/mark.svg', svg: SVG_VIEWBOX_ONLY }] }),
    )
    // viewBox is 200x50 = 4:1, so a 240x80 placement (3:1) is a real squash.
    const findings = checkAssetIntegrity(bundleFor(brain), brain)
    expect(findings.some((f) => f.check === 'logo-aspect' && f.outcome === 'fail')).toBe(true)
  })

  it('reports it at ingest too', () => {
    const plan = planIngest(
      writeBrain({ assets: [{ kind: 'logo', path: 'brand/mark.svg', svg: SVG_NO_DIMENSIONS }] }),
    )
    expect(plan.findings.some((f) => f.code === 'svg-no-intrinsic-size')).toBe(true)
    expect(isBlocked(plan)).toBe(false)
  })
})

describe('a font filename we cannot parse is reported, and still ships', () => {
  it('records the file rather than dropping it in silence', () => {
    const dir = writeBrain({ fonts: ['Ashgrove-Regular.ttf', 'ashgrove_700_normal.ttf'] })
    const brain = loadBrain(dir)

    expect(brain.unparsedFonts).toEqual(['Ashgrove-Regular.ttf'])
    expect(brain.fonts.map((f) => f.file)).toEqual(['ashgrove_700_normal.ttf'])

    const plan = planIngest(dir)
    const finding = plan.findings.find((f) => f.code === 'font-filename-unrecognised')
    expect(finding).toBeDefined()
    expect(finding?.detail).toMatch(/still hydrates/)
  })

  it('hydrates the unparsed file anyway, so the agent can use it', () => {
    const plan = planIngest(writeBrain({ fonts: ['Ashgrove-Regular.ttf'] }))
    expect(
      plan.objects.some((o) => o.storageKey.endsWith('fonts/Ashgrove-Regular.ttf')),
    ).toBe(true)
  })

  it('does not block, because a brand naming its files differently is not broken', () => {
    expect(isBlocked(planIngest(writeBrain({ fonts: ['Weird.Name.ttf'] })))).toBe(false)
  })
})

describe('a palette we cannot compare reports unverifiable, never a wall of failures', () => {
  const pantone = {
    primary: 'Pantone 158C',
    accent: 'Pantone 021C',
    surface: 'white',
    ink: 'near-black',
  }

  it('records every unreadable entry at ingest', () => {
    const plan = planIngest(writeBrain({ palette: pantone }))
    const findings = plan.findings.filter(
      (f) => f.code === 'palette-value-not-machine-readable',
    )
    expect(findings.length).toBe(4)
    expect(isBlocked(plan)).toBe(false)
  })

  it('does not fail a declared colour when nothing in the palette parsed', () => {
    const brain = loadBrain(writeBrain({ palette: pantone }))
    expect(paletteIsMachineReadable(brain)).toBe(false)

    const findings = checkPaletteConformance(bundleFor(brain, { declared: '#FE7A11' }), brain)
    expect(failures(findings)).toEqual([])
    expect(findings.some((f) => f.outcome === 'unverifiable')).toBe(true)
    expect(findings[0].detail).toMatch(/not machine-readable/)
  })

  it('softens to unverifiable when only some entries parsed', () => {
    const brain = loadBrain(
      writeBrain({ palette: { primary: '#123456', accent: 'Pantone 021C' } }),
    )
    expect(paletteIsPartial(brain)).toBe(true)

    // #FF0000 is in neither the parsed palette nor obviously wrong — the
    // unreadable entry could be exactly this colour, so absence proves nothing.
    const findings = checkPaletteConformance(bundleFor(brain, { declared: '#FF0000' }), brain)
    expect(failures(findings)).toEqual([])
    expect(findings.some((f) => f.outcome === 'unverifiable')).toBe(true)
  })

  it('still fails a foreign colour when the palette parsed completely', () => {
    const brain = loadBrain(writeBrain())
    const findings = checkPaletteConformance(bundleFor(brain, { declared: '#FF0000' }), brain)
    expect(failures(findings).length).toBe(1)
  })

  it('reports a declared value that is not a colour at all', () => {
    const brain = loadBrain(writeBrain())
    const findings = checkPaletteConformance(
      bundleFor(brain, { declared: 'var(--brand-orange)' }),
      brain,
    )
    expect(unverified(findings).length).toBe(1)
    expect(unverified(findings)[0].detail).toMatch(/not a comparable colour value/)
  })
})

describe('a self-contradicting DESIGN.md resolves deterministically', () => {
  const contradictory = {
    scale: { h1: '56px', h2: '30px' },
    applying: 'An h1 is 48px on every canvas. If it does not fit, cut the copy.',
  }

  it('detects the contradiction', () => {
    const brain = loadBrain(writeBrain(contradictory))
    const found = selfContradictions(brain)
    expect(found.length).toBe(1)
    expect(found[0].key).toBe('h1')
    expect(found[0].value).toBe('48px')
    expect(found[0].detail).toMatch(/prose governs/)
  })

  it('resolves the same way every time', () => {
    const brain = loadBrain(writeBrain(contradictory))
    const a = resolveScaleValue(brain, 'h1')
    const b = resolveScaleValue(brain, 'h1')
    expect(a).toEqual(b)
    expect(a?.source).toBe('prose')
    expect(a?.contested).toBe(true)
  })

  it('leaves uncontested keys on the table value', () => {
    const brain = loadBrain(writeBrain(contradictory))
    const h2 = resolveScaleValue(brain, 'h2')
    expect(h2?.value).toBe('30px')
    expect(h2?.source).toBe('table')
    expect(h2?.contested).toBe(false)
  })

  it('surfaces it at ingest without blocking', () => {
    const plan = planIngest(writeBrain(contradictory))
    const finding = plan.findings.find((f) => f.code === 'design-doc-self-conflict')
    expect(finding).toBeDefined()
    expect(finding?.detail).toMatch(/deterministically/)
    expect(isBlocked(plan)).toBe(false)
  })

  it('finds the real one in the packet and nothing spurious', () => {
    const contested = brains().flatMap((b) =>
      selfContradictions(b).map((c) => `${b.slug}:${c.key}=${c.value}`),
    )
    // Exactly one brain in the packet states a scale value twice.
    expect(contested.length).toBe(1)
    expect(contested[0]).toMatch(/:h1=48px$/)
  })
})

describe('brand shape differences are tolerated, not required', () => {
  it('plans a brain carrying only primary and surface', () => {
    const plan = planIngest(
      writeBrain({ palette: { primary: '#123456', surface: '#FFFFFF' } }),
    )
    expect(plan.ok).toBe(true)
    expect(isBlocked(plan)).toBe(false)
  })

  it('runs every check against a brain with no accent and no reverse logo', () => {
    const brain = loadBrain(
      writeBrain({
        palette: { primary: '#123456', surface: '#FFFFFF' },
        assets: [{ kind: 'logo', path: 'brand/mark.svg' }],
      }),
    )
    const bundle = bundleFor(brain, { declared: '#123456' })
    const raster = makePng(1080, 1080, '#123456')
    const findings = runAllChecks(bundle, brain, raster)
    expect(findings.length).toBeGreaterThan(0)
    expect(failures(findings)).toEqual([])
  })

  it('keeps both assets when two share a kind, rather than guessing', () => {
    const plan = planIngest(
      writeBrain({
        assets: [
          { kind: 'logo', path: 'brand/mark.svg' },
          { kind: 'logo', path: 'brand/mark-alt.svg' },
        ],
      }),
    )
    const logos = availableAssets(plan).filter((a) => a.kind === 'logo')
    expect(logos.length).toBe(2)
  })
})

describe('contrast is measured and reported, never enforced', () => {
  it('computes a known ratio correctly', () => {
    // Black on white is the WCAG maximum.
    expect(Math.round(contrastRatio('#000000', '#FFFFFF'))).toBe(21)
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1)
  })

  it('reports a low ratio without failing anything', () => {
    const brain = loadBrain(writeBrain())
    // Ink text sitting on a ground almost the same colour.
    const bundle = bundleFor(brain, { declared: '#101418' })
    const raster = makePng(1080, 1080, '#121619')

    const measured = measureContrast(bundle, raster)
    expect(measured.length).toBe(1)
    expect(measured[0].ratio).toBeLessThan(1.5)

    // The judgement belongs to the model looking at the render, so nothing here
    // turns a bad ratio into a build failure.
    expect(failures(runAllChecks(bundle, brain, raster))).toEqual([])
  })

  it('reports the colour actually behind the text, not an assumption', () => {
    const brain = loadBrain(writeBrain())
    const bundle = bundleFor(brain, { declared: '#FFFFFF' })
    const raster = makePng(1080, 1080, '#123456')
    const measured = measureContrast(bundle, raster)

    // The sampled colour is quantised into buckets on purpose, so a photographic
    // plate does not produce thousands of near-identical colours. It is close to
    // the ground rather than identical to it, which is the point being asserted.
    expect(colourDistance(measured[0].behindColour, '#123456')).toBeLessThan(12)
    expect(measured[0].ratio).toBeGreaterThan(7)
  })
})

describe('unverifiable is never mistaken for success', () => {
  it('is excluded from failures and surfaced by unverified', () => {
    const brain = loadBrain(
      writeBrain({
        palette: { primary: 'Pantone 158C' },
        assets: [{ kind: 'logo', path: 'brand/mark.svg', svg: SVG_NO_DIMENSIONS }],
      }),
    )
    const bundle = bundleFor(brain, { declared: '#FE7A11' })
    const raster = makePng(1080, 1080, '#123456')
    const findings = runAllChecks(bundle, brain, raster)

    const gaps = unverified(findings)
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    expect(gaps.map((f) => f.check)).toContain('logo-aspect')
    expect(gaps.map((f) => f.check)).toContain('palette-conformance')

    // Nothing failed — and that is exactly why the gaps have to be visible.
    expect(failures(findings)).toEqual([])
    for (const gap of gaps) expect(gap.outcome).not.toBe('pass')
  })

  it('a clean render against a fully readable brain has no gaps at all', () => {
    const brain = loadBrain(writeBrain())
    const bundle = bundleFor(brain, { declared: '#123456' })
    const raster = makePng(1080, 1080, '#123456')
    const findings = runAllChecks(bundle, brain, raster)
    expect(failures(findings)).toEqual([])
    expect(unverified(findings)).toEqual([])
  })
})
