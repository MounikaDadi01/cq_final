import type { Brain } from './brain'
import { normaliseHex, resolveFamily, slugify } from './brain'
import type { Box, Raster } from './png'
import { colourCoverage } from './png'

/**
 * Checks operate on a normalised bundle rather than driving a browser, so they
 * are unit-testable today and can point at real renders later without changing.
 *
 * Only checks with exact answers live here. Whether an ad is any *good* has no
 * exact answer and belongs to the model looking at the render — software that
 * grades brand conformance passes work a person would reject.
 */

export type Role = 'text' | 'logo' | 'cta'

export interface OverlayElement {
  role: Role
  box: Box
  text?: string
  /** Resolved family name as the renderer computed it. */
  fontFamily?: string
  /** Colours the element declares: fill, text, border. */
  declaredColours?: string[]
  /** The colour expected to dominate the element's box, when it has one. */
  expectedDominantColour?: string
  /** For logos: path relative to the brain directory. */
  assetPath?: string
  renderedWidth?: number
  renderedHeight?: number
}

export interface PlateInfo {
  width: number
  height: number
  /** What the model was asked for, before downscaling. */
  generatedWidth: number
  generatedHeight: number
}

export interface ArtifactBundle {
  canvas: { name: string; width: number; height: number }
  plate: PlateInfo
  overlay: OverlayElement[]
  /** The kit the run pinned. Assets from any other kit are a leak. */
  brandKitId: string
  requiredStrings: string[]
}

export interface Finding {
  check: string
  ok: boolean
  detail: string
}

const pass = (check: string, detail: string): Finding => ({ check, ok: true, detail })
const fail = (check: string, detail: string): Finding => ({ check, ok: false, detail })

/** The rendered PNG must be exactly the requested canvas. */
export function checkCanvasDimensions(bundle: ArtifactBundle, raster: Raster): Finding {
  const { width, height } = bundle.canvas
  if (raster.width === width && raster.height === height) {
    return pass('canvas-dimensions', `render is exactly ${width}x${height}`)
  }
  return fail(
    'canvas-dimensions',
    `render is ${raster.width}x${raster.height}, requested ${width}x${height}`,
  )
}

/**
 * The plate fills the canvas at its exact size, and the scale from the
 * generated size is uniform on both axes. Uniform scale from a same-aspect
 * generation is not a crop, a stretch, a letterbox or a pad.
 */
export function checkPlateGeometry(bundle: ArtifactBundle, tolerance = 0.001): Finding[] {
  const out: Finding[] = []
  const { plate, canvas } = bundle

  if (plate.width === canvas.width && plate.height === canvas.height) {
    out.push(pass('plate-fills-canvas', `plate is exactly ${canvas.width}x${canvas.height}`))
  } else {
    out.push(
      fail(
        'plate-fills-canvas',
        `plate is ${plate.width}x${plate.height}, canvas is ${canvas.width}x${canvas.height}`,
      ),
    )
  }

  const scaleX = plate.width / plate.generatedWidth
  const scaleY = plate.height / plate.generatedHeight
  const anisotropy = Math.abs(scaleX / scaleY - 1)
  if (anisotropy <= tolerance) {
    out.push(
      pass(
        'plate-uniform-scale',
        `anisotropy ${(anisotropy * 100).toFixed(4)}% within ${(tolerance * 100).toFixed(2)}%`,
      ),
    )
  } else {
    out.push(
      fail(
        'plate-uniform-scale',
        `anisotropy ${(anisotropy * 100).toFixed(4)}% exceeds ${(tolerance * 100).toFixed(2)}% — ` +
          `${plate.generatedWidth}x${plate.generatedHeight} to ${plate.width}x${plate.height} is a stretch`,
      ),
    )
  }

  if (plate.generatedWidth < plate.width || plate.generatedHeight < plate.height) {
    out.push(
      fail(
        'plate-downscaled',
        `generated ${plate.generatedWidth}x${plate.generatedHeight} is smaller than the ` +
          `${plate.width}x${plate.height} plate — upscaling invents detail`,
      ),
    )
  } else {
    out.push(pass('plate-downscaled', 'generated at or above target, then downscaled'))
  }

  return out
}

/** Every colour the overlay declares must come from this brain's palette. */
export function checkPaletteConformance(bundle: ArtifactBundle, brain: Brain): Finding[] {
  const allowed = new Set(Object.values(brain.palette))
  const out: Finding[] = []
  for (const el of bundle.overlay) {
    for (const raw of el.declaredColours ?? []) {
      const hex = normaliseHex(raw)
      if (hex === null) continue
      if (allowed.has(hex)) {
        out.push(pass('palette-conformance', `${el.role} uses ${hex} from the palette`))
      } else {
        out.push(
          fail(
            'palette-conformance',
            `${el.role} declares ${hex}, which is not in this brain's palette ` +
              `(${[...allowed].join(', ')})`,
          ),
        )
      }
    }
  }
  if (out.length === 0) out.push(pass('palette-conformance', 'no declared colours to check'))
  return out
}

/**
 * The colour the overlay declares is actually present in the pixels at that
 * position. This is the check that catches HTML and PNG drifting apart: a check
 * that only reads the HTML has verified a file nobody looks at.
 */
export function checkPixelFidelity(
  bundle: ArtifactBundle,
  raster: Raster,
  minCoverage = 0.35,
  tolerance = 24,
): Finding[] {
  const out: Finding[] = []
  for (const el of bundle.overlay) {
    if (!el.expectedDominantColour) continue
    const hex = normaliseHex(el.expectedDominantColour)
    if (hex === null) continue
    const coverage = colourCoverage(raster, el.box, hex, tolerance)
    if (coverage >= minCoverage) {
      out.push(
        pass(
          'pixel-fidelity',
          `${el.role} box carries ${hex} across ${(coverage * 100).toFixed(1)}% of its area`,
        ),
      )
    } else {
      out.push(
        fail(
          'pixel-fidelity',
          `${el.role} declares ${hex} but only ${(coverage * 100).toFixed(1)}% of its box ` +
            `matches (needs ${(minCoverage * 100).toFixed(0)}%) — the HTML and the PNG disagree`,
        ),
      )
    }
  }
  if (out.length === 0) out.push(pass('pixel-fidelity', 'no colour expectations to verify'))
  return out
}

/** Every family in use resolves to a file this brain ships. */
export function checkFontProvenance(bundle: ArtifactBundle, brain: Brain): Finding[] {
  const shipped = new Set(brain.fonts.map((f) => f.familySlug))
  const out: Finding[] = []
  for (const el of bundle.overlay) {
    if (!el.fontFamily) continue
    const want = slugify(el.fontFamily)
    if (shipped.has(want)) {
      out.push(pass('font-provenance', `${el.role} uses "${el.fontFamily}" from the brain`))
      continue
    }
    const resolution = resolveFamily(brain, el.fontFamily)
    out.push(
      fail(
        'font-provenance',
        `${el.role} renders in "${el.fontFamily}", which this brain does not ship. ` +
          (resolution.resolvedFamilySlug
            ? `Substitution policy would give "${resolution.resolvedFamilySlug}" at ${resolution.weight}; ` +
              'the render must use the substituted family, not the requested one.'
            : 'No shipped family matches — browser fallback is not the brand.'),
      ),
    )
  }
  if (out.length === 0) out.push(pass('font-provenance', 'no text elements to check'))
  return out
}

/**
 * Placed assets resolve to a real file, belong to the run's kit, and keep their
 * intrinsic proportions. The kit check is the one that stops a mis-tagged asset
 * from carrying another customer's mark onto this canvas.
 */
export function checkAssetIntegrity(
  bundle: ArtifactBundle,
  brain: Brain,
  aspectTolerance = 0.01,
): Finding[] {
  const out: Finding[] = []
  for (const el of bundle.overlay) {
    if (el.role !== 'logo' || !el.assetPath) continue
    const asset = brain.assets.find((a) => a.path === el.assetPath)

    if (!asset) {
      out.push(
        fail('asset-in-manifest', `${el.assetPath} is placed but is not in the asset manifest`),
      )
      continue
    }
    if (!asset.exists) {
      out.push(
        fail(
          'asset-resolves',
          `${el.assetPath} is in the manifest but no file exists — a path is not an asset`,
        ),
      )
      continue
    }
    out.push(pass('asset-resolves', `${el.assetPath} resolves to a file`))

    if (asset.kitId !== bundle.brandKitId) {
      out.push(
        fail(
          'asset-kit-match',
          `${el.assetPath} belongs to kit ${asset.kitId} but the run pinned ` +
            `${bundle.brandKitId} — cross-tenant asset`,
        ),
      )
    } else {
      out.push(pass('asset-kit-match', `${el.assetPath} belongs to ${bundle.brandKitId}`))
    }

    if (
      asset.naturalWidth &&
      asset.naturalHeight &&
      el.renderedWidth &&
      el.renderedHeight
    ) {
      const natural = asset.naturalWidth / asset.naturalHeight
      const rendered = el.renderedWidth / el.renderedHeight
      const drift = Math.abs(rendered / natural - 1)
      if (drift <= aspectTolerance) {
        out.push(
          pass(
            'logo-aspect',
            `${el.assetPath} rendered at ${rendered.toFixed(4)} against natural ${natural.toFixed(4)}`,
          ),
        )
      } else {
        out.push(
          fail(
            'logo-aspect',
            `${el.assetPath} rendered aspect ${rendered.toFixed(4)} differs from natural ` +
              `${natural.toFixed(4)} by ${(drift * 100).toFixed(2)}% — unequal X and Y scale`,
          ),
        )
      }
    }
  }
  if (out.length === 0) out.push(pass('asset-integrity', 'no logos placed'))
  return out
}

/** Every required string is present as live text. */
export function checkRequiredStrings(bundle: ArtifactBundle): Finding[] {
  const rendered = bundle.overlay.map((el) => (el.text ?? '').trim()).filter(Boolean)
  return bundle.requiredStrings.map((required) => {
    const found = rendered.some((t) => t.includes(required.trim()))
    return found
      ? pass('required-strings', `"${truncate(required)}" is present`)
      : fail('required-strings', `"${truncate(required)}" is missing from the overlay`)
  })
}

/** Nothing hangs off the canvas. */
export function checkInBounds(bundle: ArtifactBundle): Finding[] {
  const { width, height } = bundle.canvas
  return bundle.overlay.map((el) => {
    const { x, y, width: w, height: h } = el.box
    const inside = x >= 0 && y >= 0 && x + w <= width && y + h <= height
    return inside
      ? pass('in-bounds', `${el.role} is within the canvas`)
      : fail(
          'in-bounds',
          `${el.role} at ${x},${y} ${w}x${h} extends outside the ${width}x${height} canvas`,
        )
  })
}

/** No two overlays sit on top of each other. */
export function checkNoOverlap(bundle: ArtifactBundle): Finding[] {
  const out: Finding[] = []
  const els = bundle.overlay
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      if (overlaps(els[i].box, els[j].box)) {
        out.push(
          fail(
            'no-overlap',
            `${els[i].role} overlaps ${els[j].role} ` +
              `(${describe(els[i].box)} and ${describe(els[j].box)})`,
          ),
        )
      }
    }
  }
  if (out.length === 0) out.push(pass('no-overlap', `${els.length} overlays, none overlapping`))
  return out
}

/** Every overlay carries a stable role. */
export function checkRoles(bundle: ArtifactBundle): Finding[] {
  const valid: Role[] = ['text', 'logo', 'cta']
  return bundle.overlay.map((el) =>
    valid.includes(el.role)
      ? pass('overlay-roles', `role "${el.role}" is valid`)
      : fail('overlay-roles', `"${String(el.role)}" is not one of ${valid.join(', ')}`),
  )
}

export function runAllChecks(
  bundle: ArtifactBundle,
  brain: Brain,
  raster: Raster,
): Finding[] {
  return [
    checkCanvasDimensions(bundle, raster),
    ...checkPlateGeometry(bundle),
    ...checkPaletteConformance(bundle, brain),
    ...checkPixelFidelity(bundle, raster),
    ...checkFontProvenance(bundle, brain),
    ...checkAssetIntegrity(bundle, brain),
    ...checkRequiredStrings(bundle),
    ...checkInBounds(bundle),
    ...checkNoOverlap(bundle),
    ...checkRoles(bundle),
  ]
}

export const failures = (findings: Finding[]): Finding[] => findings.filter((f) => !f.ok)

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  )
}

const describe = (b: Box) => `${b.x},${b.y} ${b.width}x${b.height}`
const truncate = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n)}…` : s)
