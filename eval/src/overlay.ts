import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Brain } from './brain'
import { placeLogo, type Corner, type CornerReading } from './logo-placement'
import { luminanceAt, type Raster } from './png'
import { DARK_GROUND_LUMINANCE, paletteExtremes } from './brain'
import type { Campaign, CampaignCanvas } from './campaign'

/**
 * Builds the overlay HTML for one canvas.
 *
 * The contract is SKILL.md's, not ours: exactly one fixed canvas root with
 * explicit pixel dimensions and clipped overflow, exactly one full-canvas local
 * raster plate, and every word a positioned overlay carrying a `data-cq-role`.
 * Nothing in the overlay layer draws anything except text, a logo, or a CTA.
 *
 * Every colour and size resolves from the brain. The *layout* intent — where copy
 * sits, whether a CTA is filled or outlined — comes from the campaign fixture,
 * because those are prose rules in `DESIGN.md` that a person read. In the running
 * system the agent reads that prose itself; pinning it here keeps Gate 0
 * deterministic without putting brand knowledge in code.
 */

export interface TextStyle {
  role: 'eyebrow' | 'headline' | 'subhead' | 'legal'
  /** A palette key, resolved against the brain. */
  colour: string
  size: string
  weight: number
  tracking?: string
  leading?: number
  uppercase?: boolean
}

export interface CtaStyle {
  size: string
  weight: number
  /** Palette key, or `none` for an outline-only button. */
  fill: string
  label: string
  border?: string
  radius: string
}

export interface CampaignStyle {
  /** Drives the logo choice and the default text colour. */
  ground: 'dark' | 'light'
  /** Where the plate promises quiet space. */
  copyArea: 'upper' | 'lower' | 'left'
  logoPosition: 'top-left' | 'top-right'
  eyebrow?: TextStyle
  headline: TextStyle
  subhead?: TextStyle
  cta: CtaStyle
}

export interface BuiltOverlay {
  html: string
  /** Every family the document actually asks for, as loaded face names. */
  expectedFaces: string[]
  logoPath: string | null
  logoNote: string
  logoCorner: string | null
  /** Why this variant, and how uniform the ground under it was. */
  logoGround: {
    /** True when the corner was asked for rather than picked. */
    forced: boolean
    /** Neutral reading of the ground at the requested corner, or null. */
    forcedNote: string | null
    plateLuminance: number
    groundIsDark: boolean
    switchPoint: number
    switchPointSource: string
    straddled: boolean
  }
  /** Brightness measured where the copy sits, and what it implied. */
  copyGround: { luminance: number; treatedAs: 'dark' | 'light'; declared: string }
  /** Every corner considered and what it measured, so the choice is auditable. */
  logoConsidered: CornerReading[]
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A CSS-safe face name derived from a shipped font file. */
const faceName = (familySlug: string, weight: number) => `brain-${familySlug}-${weight}`

function resolveColour(brain: Brain, key: string): string {
  if (key === 'none') return 'transparent'
  const hex = brain.palette[key]
  if (!hex) throw new Error(`palette has no "${key}" — available: ${Object.keys(brain.palette)}`)
  return hex
}

/**
 * `@font-face` with a `file://` source, and nothing else.
 *
 * This is the single most likely silent failure in the whole build: Chromium will
 * not use a TTF sitting in a directory. Without these rules the render looks
 * plausible and the type is wrong, which is exactly what "browser fallback is not
 * the brand" is warning about.
 */
function fontFaces(brain: Brain): { css: string; faces: string[] } {
  const rules: string[] = []
  const faces: string[] = []
  for (const font of brain.fonts) {
    const name = faceName(font.familySlug, font.weight)
    faces.push(name)
    rules.push(
      `@font-face{font-family:'${name}';src:url('file://${font.path}') format('truetype');` +
        `font-weight:${font.weight};font-style:normal;font-display:block}`,
    )
  }
  return { css: rules.join('\n'), faces }
}

/** Which shipped weight actually backs a requested one. */
function weightFor(brain: Brain, familySlug: string, wanted: number): number {
  const available = brain.fonts.filter((f) => f.familySlug === familySlug).map((f) => f.weight)
  if (available.length === 0) throw new Error(`no shipped weights for ${familySlug}`)
  if (available.includes(wanted)) return wanted
  // Nearest, breaking ties heavier — a heading should not thin out silently.
  return available.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted) || b - a)[0]
}

export interface OverlayInput {
  brain: Brain
  campaign: Campaign
  canvas: CampaignCanvas
  style: CampaignStyle
  /** Path to the plate, relative to the HTML file. */
  platePath: string
  /** The family slug the brain resolved for headings. */
  headingSlug: string
  bodySlug: string
  /** The finished plate, so the logo can be placed by measurement. */
  plateRaster: Raster
  /**
   * Where the logo goes. Absent means "pick a free corner".
   *
   * Picking is a convenience for when nobody has said. It is not what keeps the right
   * logo on the right ground — that is the variant choice, made from the ad's overall
   * brightness — so this can be directed freely without weakening anything.
   */
  forceLogoCorner?: Corner
  /**
   * Per-line colour, keyed by line name, overriding the band-measured default.
   *
   * A band average says what a region is like on the whole; it cannot say what
   * sits behind one headline. The runner renders once, reads the pixels actually
   * behind each line, and passes corrections back through here.
   */
  forcedTextColours?: Record<string, string>
}

export function buildOverlay(input: OverlayInput): BuiltOverlay {
  const { brain, campaign, canvas, style, platePath, headingSlug, bodySlug, plateRaster } = input
  const forced = input.forcedTextColours ?? {}
  const { width, height } = canvas
  const { css: faceCss, faces } = fontFaces(brain)

  const margin = Math.round(Math.min(width, height) * 0.07)
  // The kit's own light and dark ends, found by luminance. Looking up the keys
  // `surface` and `ink` worked on these two brands and would return undefined on
  // a third that named them differently — silently, since a missing candidate
  // just means no colour is ever corrected.
  const extremes = paletteExtremes(brain)
  const surface = extremes?.lightest ?? '#FFFFFF'
  const ink = extremes?.darkest ?? '#000000'

  // Measured, not declared. A campaign can say `ground: dark` and the model can
  // hand back an overcast plate — which is exactly what happened once, producing
  // white type on light sheeting at a contrast ratio of 1.0. The plate exists by
  // the time we lay out, so its brightness is a fact rather than an assumption.
  const copyBand =
    style.copyArea === 'upper'
      ? { x: margin, y: margin, width: width - 2 * margin, height: Math.round(height * 0.38) }
      : style.copyArea === 'left'
        ? { x: margin, y: Math.round(height * 0.3), width: Math.round(width * 0.52), height: Math.round(height * 0.4) }
        : { x: margin, y: Math.round(height * 0.6), width: width - 2 * margin, height: Math.round(height * 0.34) }
  const copyLuminance = luminanceAt(plateRaster, copyBand)
  const onDark = copyLuminance < DARK_GROUND_LUMINANCE
  const defaultText = onDark ? surface : ink

  // Candidates exclude the half the copy stack occupies, so a measured placement
  // cannot collide with type. Within what is left, the plate decides.
  const corners: Corner[] =
    style.copyArea === 'upper'
      ? ['bottom-left', 'bottom-right']
      : style.copyArea === 'left'
        ? ['top-right', 'bottom-right']
        : ['top-left', 'top-right']

  // Sized from the largest asset's aspect so every candidate samples the same box.
  const probe = brain.assets.find((a) => a.exists && a.naturalWidth && a.naturalHeight)
  const probeAspect = probe?.naturalWidth && probe.naturalHeight
    ? probe.naturalWidth / probe.naturalHeight
    : 1
  const probeHeight = Math.round(height * 0.085)

  const placement = placeLogo(brain, plateRaster, {
    canvasWidth: width,
    canvasHeight: height,
    logoWidth: Math.round(probeHeight * probeAspect),
    logoHeight: probeHeight,
    margin,
    corners,
    forceCorner: input.forceLogoCorner,
  })
  const choice = placement
  const logo = placement.asset

  let logoHtml = ''
  if (logo?.naturalWidth && logo.naturalHeight) {
    const targetHeight = Math.round(height * 0.085)
    const logoWidth = Math.round(targetHeight * (logo.naturalWidth / logo.naturalHeight))
    const side = placement.corner.endsWith('right') ? `right:${margin}px` : `left:${margin}px`
    const vertical = placement.corner.startsWith('top') ? `top:${margin}px` : `bottom:${margin}px`
    // Intrinsic proportions preserved: one dimension is constrained and the other
    // resolves. object-fit:contain guarantees no unequal scale even if the box drifts.
    logoHtml =
      `<img data-cq-role="logo" src="${escape(logo.path.split('/').pop() as string)}" ` +
      `alt="" style="position:absolute;${vertical};${side};` +
      `width:${logoWidth}px;height:${targetHeight}px;` +
      `max-width:100%;max-height:100%;object-fit:contain">`
  }

  /**
   * Resolves a declared palette colour, letting the measured ground decide when
   * the declaration is one of the kit's two extremes.
   *
   * A campaign asking for the lightest colour is asking for "whatever reads on a
   * dark ground", not literally white — so on a light plate it flips. A campaign
   * asking for the accent means the accent, and keeps it.
   */
  const groundAware = (name: string) => {
    const resolved = resolveColour(brain, name)
    return resolved === surface || resolved === ink ? defaultText : resolved
  }

  const textBlocks: string[] = []
  const line = (text: string | null | undefined, s: TextStyle | undefined) => {
    if (!text || !s) return
    const slug = s.role === 'headline' ? headingSlug : bodySlug
    const weight = weightFor(brain, slug, s.weight)
    textBlocks.push(
      `<div data-cq-role="text" data-cq-line="${s.role}" style="` +
        `font-family:'${faceName(slug, weight)}';font-weight:${weight};` +
        `font-size:${s.size};color:${forced[s.role] ?? groundAware(s.colour)};` +
        (s.leading ? `line-height:${s.leading};` : 'line-height:1.25;') +
        (s.tracking ? `letter-spacing:${s.tracking};` : '') +
        (s.uppercase ? 'text-transform:uppercase;' : '') +
        `margin:0">${escape(text)}</div>`,
    )
  }

  line(campaign.copy.eyebrow, style.eyebrow)
  line(campaign.copy.headline, style.headline)
  line(campaign.copy.subhead, style.subhead)

  const ctaWeight = weightFor(brain, bodySlug, style.cta.weight)
  const ctaFill = resolveColour(brain, style.cta.fill)
  const ctaBorder = style.cta.border
    ? `border:2px solid ${resolveColour(brain, style.cta.border)};`
    : ''
  const ctaHtml =
    `<a data-cq-role="cta" href="${escape(campaign.copy.cta_href ?? '#')}" style="` +
    `display:inline-block;font-family:'${faceName(bodySlug, ctaWeight)}';` +
    `font-weight:${ctaWeight};font-size:${style.cta.size};` +
    // An outlined button sits on the plate, so its label follows the ground; a
    // filled button sits on its own fill, so it keeps what the brand declared.
    `color:${ctaFill === 'transparent' ? groundAware(style.cta.label) : resolveColour(brain, style.cta.label)};` +
    `background:${ctaFill};${ctaBorder}` +
    `border-radius:${style.cta.radius};padding:0.7em 1.4em;text-decoration:none;` +
    `white-space:nowrap">${escape(campaign.copy.cta)}</a>`

  const legal = campaign.copy.legal
    ? `<div data-cq-role="text" data-cq-line="legal" style="font-family:'${faceName(bodySlug, weightFor(brain, bodySlug, 400))}';` +
      `font-size:12px;color:${forced.legal ?? defaultText};opacity:.75;margin:0">${escape(campaign.copy.legal)}</div>`
    : ''

  const stackPosition =
    style.copyArea === 'upper'
      ? `top:${margin + Math.round(height * 0.1)}px;left:${margin}px;right:${margin}px`
      : style.copyArea === 'left'
        ? `top:50%;transform:translateY(-50%);left:${margin}px;width:${Math.round(width * 0.52)}px`
        : // Top-anchored into the lower zone rather than pinned to the bottom edge:
        // bottom-pinning a short stack on a tall canvas leaves a dead band above it.
        `top:${Math.round(height * 0.62)}px;left:${margin}px;right:${margin}px`

  const gap = Math.round(Math.min(width, height) * 0.022)

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:${defaultText === surface ? ink : surface}}
${faceCss}
#canvas{position:relative;width:${width}px;height:${height}px;overflow:hidden}
#plate{position:absolute;inset:0;width:${width}px;height:${height}px;display:block}
#stack{position:absolute;${stackPosition};display:flex;flex-direction:column;gap:${gap}px;align-items:flex-start}
</style></head>
<body>
<div id="canvas">
  <img id="plate" src="${escape(platePath)}" alt="">
  ${logoHtml}
  <div id="stack">
    ${textBlocks.join('\n    ')}
    ${ctaHtml}
    ${legal}
  </div>
</div>
</body></html>`

  return {
    html,
    expectedFaces: faces,
    logoPath: logo?.absolutePath ?? null,
    logoNote: choice.reason,
    logoCorner: logo ? placement.corner : null,
    copyGround: {
      luminance: Number(copyLuminance.toFixed(3)),
      treatedAs: onDark ? 'dark' : 'light',
      declared: style.ground,
    },
    logoConsidered: placement.considered,
  logoGround: {
    forced: placement.forced,
    forcedNote: placement.forcedNote,
    plateLuminance: placement.plateLuminance,
    groundIsDark: placement.groundIsDark,
    switchPoint: placement.switchPoint,
    switchPointSource: placement.switchPointSource,
    straddled: placement.straddled,
  },
  }
}

/** Copies the brain assets an overlay references next to the HTML. */
export function assetsToCopy(brain: Brain, logoAbsolutePath: string | null): string[] {
  if (!logoAbsolutePath || !existsSync(logoAbsolutePath)) return []
  return [logoAbsolutePath]
}

export function readSvg(path: string): string {
  return readFileSync(path, 'utf8')
}

export const brainFontDir = (brain: Brain) => join(brain.dir, 'fonts')
