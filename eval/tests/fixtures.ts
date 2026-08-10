import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Brain } from '../src/brain'
import { discoverBrains, loadBrain } from '../src/brain'
import { GPT_IMAGE_2, planGeneration } from '../src/capability'
import type { ArtifactBundle, OverlayElement } from '../src/checks'
import { makePng, type Raster } from '../src/png'

const here = dirname(fileURLToPath(import.meta.url))
export const PACKET = resolve(here, '..', '..', 'packet')

/**
 * Finds the directory whose children are brains, rather than assuming how deep
 * the archive nests them. A third brain dropped in anywhere sensible is found.
 */
export function findBrainsRoot(root = PACKET): string | null {
  if (!existsSync(root)) return null
  const queue = [root]
  while (queue.length > 0) {
    const dir = queue.shift() as string
    const children = readdirSync(dir)
      .map((n) => join(dir, n))
      .filter((p) => statSync(p).isDirectory())
    if (children.some((c) => existsSync(join(c, 'DESIGN.md')))) return dir
    queue.push(...children)
  }
  return null
}

export function brains(): Brain[] {
  const root = findBrainsRoot()
  return root ? discoverBrains(root) : []
}

export function brainSlugs(): string[] {
  return brains().map((b) => b.slug)
}

export interface Canvas {
  name: string
  width: number
  height: number
}

/**
 * Canvas sizes come from the example request in the packet, not from a constant
 * written here, so the suite exercises whatever an operator actually submits.
 */
export function canvasesFromPacket(): Canvas[] {
  const found: Canvas[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.json')) {
        try {
          const doc = JSON.parse(readFileSync(full, 'utf8'))
          const list = doc.canvases ?? doc.edits?.canvases
          if (Array.isArray(list)) {
            for (const c of list) {
              if (c?.name && c?.width && c?.height && !found.some((f) => f.name === c.name)) {
                found.push({ name: c.name, width: c.width, height: c.height })
              }
            }
          }
        } catch {
          /* not a request payload */
        }
      }
    }
  }
  walk(PACKET)
  return found
}

const pick = <T,>(record: Record<string, T>, key: string): T | undefined => record[key]

/** Accent if the brain names one, otherwise the first colour that is not the surface. */
export function accentOf(brain: Brain): string {
  const accent = pick(brain.palette, 'accent')
  if (accent) return accent
  const surface = pick(brain.palette, 'surface')
  const other = Object.values(brain.palette).find((c) => c !== surface)
  if (!other) throw new Error(`${brain.slug} has no usable palette colour`)
  return other
}

export function groundOf(brain: Brain): string {
  return pick(brain.palette, 'primary') ?? Object.values(brain.palette)[0]
}

export function inkOf(brain: Brain): string {
  return pick(brain.palette, 'ink') ?? pick(brain.palette, 'surface') ?? '#FFFFFF'
}

/** A logo that resolves to a file and belongs to this brain's own kit. */
export function ownLogoOf(brain: Brain) {
  return brain.assets.find((a) => a.kind === 'logo' && a.kitId === brain.kitId && a.exists)
}

/** An asset tagged with a kit other than the brain's own — a planted leak, if present. */
export function foreignAssetOf(brain: Brain) {
  return brain.assets.find((a) => a.kitId !== brain.kitId && a.exists)
}

/** An asset the manifest lists but no file backs. */
export function missingAssetOf(brain: Brain) {
  return brain.assets.find((a) => !a.exists)
}

export interface BuiltFixture {
  bundle: ArtifactBundle
  raster: Raster
  accent: string
}

/**
 * Builds a compliant artifact bundle for any brain and any canvas.
 *
 * Every value is derived from the brain: colours from its palette, the font from
 * the families it ships, the logo from its own manifest at the file's intrinsic
 * aspect. Nothing here knows which customer it is describing, so the same
 * builder covers a brand seen for the first time.
 */
export function buildFixture(brain: Brain, canvas: Canvas): BuiltFixture {
  const plan = planGeneration(canvas.width, canvas.height, GPT_IMAGE_2)
  if (!plan.ok) {
    throw new Error(`${canvas.name} cannot be planned: ${plan.reasons.join('; ')}`)
  }

  const accent = accentOf(brain)
  const ground = groundOf(brain)
  const ink = inkOf(brain)
  const logo = ownLogoOf(brain)
  const family = brain.fonts[0]?.familySlug
  if (!family) throw new Error(`${brain.slug} ships no fonts`)

  const margin = Math.max(4, Math.round(Math.min(canvas.width, canvas.height) * 0.05))
  const rowHeight = Math.floor((canvas.height - 4 * margin) / 3)
  const contentWidth = canvas.width - 2 * margin

  const overlay: OverlayElement[] = []

  if (logo && logo.naturalWidth && logo.naturalHeight) {
    // Constrain one dimension and let the other resolve, per the skill file.
    // Clamping width without recomputing height is an unequal X and Y scale —
    // the checks caught exactly that in the first draft of this builder.
    const aspect = logo.naturalWidth / logo.naturalHeight
    let h = rowHeight
    let w = Math.round(h * aspect)
    if (w > contentWidth) {
      w = contentWidth
      h = Math.round(w / aspect)
    }
    overlay.push({
      role: 'logo',
      box: { x: margin, y: margin, width: w, height: h },
      assetPath: logo.path,
      renderedWidth: w,
      renderedHeight: h,
    })
  }

  const headline = 'Every word here is live selectable text'
  overlay.push({
    role: 'text',
    box: {
      x: margin,
      y: margin + rowHeight + margin,
      width: contentWidth,
      height: rowHeight,
    },
    text: headline,
    fontFamily: family,
    declaredColours: [ink],
  })

  const ctaLabel = 'See the brief'
  const ctaBox = {
    x: margin,
    y: margin + 2 * (rowHeight + margin),
    width: Math.min(contentWidth, Math.max(48, Math.round(canvas.width * 0.3))),
    height: rowHeight,
  }
  overlay.push({
    role: 'cta',
    box: ctaBox,
    text: ctaLabel,
    fontFamily: family,
    declaredColours: [accent],
    expectedDominantColour: accent,
  })

  const bundle: ArtifactBundle = {
    canvas,
    plate: {
      width: canvas.width,
      height: canvas.height,
      generatedWidth: plan.generateWidth,
      generatedHeight: plan.generateHeight,
    },
    overlay,
    brandKitId: brain.kitId,
    requiredStrings: [headline, ctaLabel],
  }

  // The synthetic render agrees with the overlay: the CTA region really carries
  // the accent, so pixel fidelity passes for the right reason.
  const raster = makePng(canvas.width, canvas.height, ground, [{ ...ctaBox, color: accent }])

  return { bundle, raster, accent }
}

/** Deep-enough clone for mutating a bundle in a planted-violation test. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export { loadBrain }
