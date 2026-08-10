import { describe, expect, it } from 'vitest'
import {
  checkAssetIntegrity,
  checkCanvasDimensions,
  checkFontProvenance,
  checkInBounds,
  checkNoOverlap,
  checkPaletteConformance,
  checkPixelFidelity,
  checkPlateGeometry,
  checkRequiredStrings,
  checkRoles,
  failures,
  runAllChecks,
} from '../src/checks'
import { makePng } from '../src/png'
import {
  brains,
  buildFixture,
  canvasesFromPacket,
  clone,
  foreignAssetOf,
  groundOf,
  missingAssetOf,
} from './fixtures'
import { GPT_IMAGE_2, planGeneration } from '../src/capability'

const all = brains()
/** Only canvases the model can actually serve produce a renderable fixture. */
const servable = canvasesFromPacket().filter(
  (c) => planGeneration(c.width, c.height, GPT_IMAGE_2).ok,
)

const cases = all.flatMap((brain) => servable.map((canvas) => ({ brain, canvas })))

describe('a compliant render passes every check, for every brain and canvas', () => {
  it('has cases to run', () => {
    expect(cases.length).toBeGreaterThan(0)
  })

  it.each(cases)('$brain.slug $canvas.name', ({ brain, canvas }) => {
    const { bundle, raster } = buildFixture(brain, canvas)
    const found = failures(runAllChecks(bundle, brain, raster))
    expect(found.map((f) => `${f.check}: ${f.detail}`)).toEqual([])
  })
})

/**
 * Every check below is handed a planted violation. A check that has never fired
 * is indistinguishable from a clean render, so "no failures found" only means
 * something once each detector has been shown to see.
 */
describe('each check catches its planted violation', () => {
  const brain = all[0]
  const canvas = servable[0]

  it('canvas dimensions: a render that is not the requested size', () => {
    const { bundle } = buildFixture(brain, canvas)
    const wrong = makePng(canvas.width + 8, canvas.height, groundOf(brain))
    expect(checkCanvasDimensions(bundle, wrong).ok).toBe(false)
  })

  it('plate geometry: a plate that does not fill the canvas', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    broken.plate.width = canvas.width - 20
    const found = failures(checkPlateGeometry(broken))
    expect(found.some((f) => f.check === 'plate-fills-canvas')).toBe(true)
  })

  it('plate geometry: a non-uniform scale, which is a stretch', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    // Same target, but generated at an aspect that does not match it.
    broken.plate.generatedWidth = Math.round(bundle.plate.generatedWidth * 1.2)
    const found = failures(checkPlateGeometry(broken))
    expect(found.some((f) => f.check === 'plate-uniform-scale')).toBe(true)
    expect(found.find((f) => f.check === 'plate-uniform-scale')?.detail).toMatch(/stretch/)
  })

  it('plate geometry: generating below target, which upscales', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    broken.plate.generatedWidth = Math.round(canvas.width / 2)
    broken.plate.generatedHeight = Math.round(canvas.height / 2)
    const found = failures(checkPlateGeometry(broken))
    expect(found.some((f) => f.check === 'plate-downscaled')).toBe(true)
  })

  it('palette conformance: a colour from outside the brain', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    // The Kahua inspiration in the packet uses a red CTA that is not in the
    // palette; sampling an inspiration is exactly this mistake.
    broken.overlay[broken.overlay.length - 1].declaredColours = ['#E4002B']
    const found = failures(checkPaletteConformance(broken, brain))
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].detail).toMatch(/not in this brain's palette/)
  })

  it('pixel fidelity: the HTML declares a colour the PNG does not carry', () => {
    const { bundle } = buildFixture(brain, canvas)
    // A render where the CTA was never painted: the overlay still claims the
    // accent, so HTML and PNG disagree without either looking wrong alone.
    const blank = makePng(canvas.width, canvas.height, groundOf(brain))
    const found = failures(checkPixelFidelity(bundle, blank))
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].detail).toMatch(/the HTML and the PNG disagree/)
  })

  it('font provenance: a family the brain does not ship', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    for (const el of broken.overlay) {
      if (el.fontFamily) el.fontFamily = 'Helvetica Neue'
    }
    const found = failures(checkFontProvenance(broken, brain))
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].detail).toMatch(/does not ship/)
  })

  it('asset integrity: a logo from another kit', () => {
    const withForeign = all.find((b) => foreignAssetOf(b) !== undefined)
    expect(withForeign).toBeDefined()
    if (!withForeign) return

    const foreign = foreignAssetOf(withForeign)!
    const { bundle } = buildFixture(withForeign, canvas)
    const broken = clone(bundle)
    broken.overlay.push({
      role: 'logo',
      box: { x: 0, y: 0, width: 10, height: 10 },
      assetPath: foreign.path,
      renderedWidth: 10,
      renderedHeight: 10,
    })
    const found = failures(checkAssetIntegrity(broken, withForeign))
    expect(found.some((f) => f.check === 'asset-kit-match')).toBe(true)
    expect(found.find((f) => f.check === 'asset-kit-match')?.detail).toMatch(
      /cross-tenant asset/,
    )
  })

  it('asset integrity: a manifest path with no file behind it', () => {
    const withMissing = all.find((b) => missingAssetOf(b) !== undefined)
    expect(withMissing).toBeDefined()
    if (!withMissing) return

    const missing = missingAssetOf(withMissing)!
    const { bundle } = buildFixture(withMissing, canvas)
    const broken = clone(bundle)
    broken.overlay.push({
      role: 'logo',
      box: { x: 0, y: 0, width: 10, height: 10 },
      assetPath: missing.path,
    })
    const found = failures(checkAssetIntegrity(broken, withMissing))
    expect(found.some((f) => f.check === 'asset-resolves')).toBe(true)
    expect(found.find((f) => f.check === 'asset-resolves')?.detail).toMatch(
      /a path is not an asset/,
    )
  })

  it('asset integrity: a logo squashed off its natural proportions', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    const logo = broken.overlay.find((el) => el.role === 'logo')
    expect(logo).toBeDefined()
    if (!logo) return
    logo.renderedWidth = Math.round((logo.renderedWidth ?? 100) * 1.4)
    const found = failures(checkAssetIntegrity(broken, brain))
    expect(found.some((f) => f.check === 'logo-aspect')).toBe(true)
  })

  it('required strings: a headline that never made it into the overlay', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    broken.overlay = broken.overlay.filter((el) => el.role !== 'text')
    const found = failures(checkRequiredStrings(broken))
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].detail).toMatch(/missing from the overlay/)
  })

  it('bounds: an overlay hanging off the canvas', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    broken.overlay[0].box.x = canvas.width - 2
    broken.overlay[0].box.width = 200
    const found = failures(checkInBounds(broken))
    expect(found.length).toBeGreaterThan(0)
  })

  it('overlap: two overlays on top of each other', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    broken.overlay[1].box = { ...broken.overlay[0].box }
    const found = failures(checkNoOverlap(broken))
    expect(found.length).toBeGreaterThan(0)
  })

  it('roles: an overlay with no recognised role', () => {
    const { bundle } = buildFixture(brain, canvas)
    const broken = clone(bundle)
    ;(broken.overlay[0] as { role: string }).role = 'decoration'
    const found = failures(checkRoles(broken))
    expect(found.length).toBeGreaterThan(0)
  })
})

describe('the suite would notice if a detector stopped detecting', () => {
  it('every check name appears in at least one failing case', () => {
    const brain = all[0]
    const canvas = servable[0]
    const { bundle, raster } = buildFixture(brain, canvas)

    // Names produced on a clean render, so the list of checks is derived rather
    // than written down and left to rot.
    const names = new Set(runAllChecks(bundle, brain, raster).map((f) => f.check))
    expect(names.size).toBeGreaterThanOrEqual(9)
    for (const required of [
      'canvas-dimensions',
      'plate-fills-canvas',
      'plate-uniform-scale',
      'palette-conformance',
      'pixel-fidelity',
      'font-provenance',
      'required-strings',
      'in-bounds',
      'no-overlap',
      'overlay-roles',
    ]) {
      expect(names).toContain(required)
    }
  })
})
