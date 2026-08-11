import { chromium, type Browser } from 'playwright'
import { decodePng, type Raster } from './png'

/**
 * HTML to PNG at exact canvas bounds, with the font check that stops the most
 * likely silent failure in the build.
 *
 * Chromium will not use a TTF that merely sits in a directory. Without a loaded
 * `@font-face` the page renders in a fallback and looks entirely plausible — which
 * is why this asserts on `document.fonts.check()` rather than trusting the CSS to
 * have worked. "Browser fallback is not the brand" only means something if
 * something checks.
 */

export interface MeasuredElement {
  role: 'text' | 'logo' | 'cta'
  line: string
  box: { x: number; y: number; width: number; height: number }
  text?: string
  /** The loaded face, e.g. `brain-barlow-700`. */
  fontFamily?: string
  /** The brain family the face came from, e.g. `barlow`. */
  familySlug?: string
  /** Computed colours, as hex, so palette conformance sees what rendered. */
  colours: string[]
  src?: string
  naturalWidth?: number
  naturalHeight?: number
}

interface RawMeasured {
  role: string
  line: string
  box: { x: number; y: number; width: number; height: number }
  text?: string
  fontFamily?: string
  colourStrings: string[]
  src?: string
  naturalWidth?: number
  naturalHeight?: number
}

/** `brain-barlow-700` back to the brain family slug `barlow`. */
export function faceToFamilySlug(face: string | undefined): string | undefined {
  if (!face?.startsWith('brain-')) return undefined
  return face.replace(/^brain-/, '').replace(/-\d+$/, '')
}

/** `rgb(242, 107, 33)` to `#F26B21`. Fully transparent resolves to nothing. */
export function cssColourToHex(value: string): string | null {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value.trim())
  if (!m) return null
  if (m[4] !== undefined && Number(m[4]) === 0) return null
  const hex = (n: string) => Number(n).toString(16).padStart(2, '0')
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`.toUpperCase()
}

export interface RenderResult {
  raster: Raster
  png: Buffer
  /** Faces the document declared and the browser actually loaded. */
  loadedFaces: string[]
  missingFaces: string[]
  /** Computed family per text element, as the browser resolved it. */
  computed: { role: string; line: string; family: string; size: string; weight: string }[]
  /** Measured geometry and computed styling, straight out of the render. */
  elements: MeasuredElement[]
}

export async function renderCanvas(options: {
  htmlPath: string
  width: number
  height: number
  expectedFaces: string[]
  browser?: Browser
}): Promise<RenderResult> {
  const owned = options.browser === undefined
  const browser = options.browser ?? (await chromium.launch())

  try {
    const page = await browser.newPage({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: 1,
    })

    await page.goto(`file://${options.htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)

    // A face is only usable if the browser says it is. Asking per declared face
    // and per weight catches a wrong path, an unreadable file, or a weight that
    // was never shipped.
    const faceStatus = await page.evaluate((faces: string[]) => {
      const out: Record<string, boolean> = {}
      for (const face of faces) out[face] = document.fonts.check(`16px '${face}'`)
      return out
    }, options.expectedFaces)

    const computed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-cq-role="text"],[data-cq-role="cta"]')).map(
        (el) => {
          const s = getComputedStyle(el as Element)
          return {
            role: (el as HTMLElement).dataset.cqRole ?? '',
            line: (el as HTMLElement).dataset.cqLine ?? 'cta',
            family: s.fontFamily,
            size: s.fontSize,
            weight: s.fontWeight,
          }
        },
      ),
    )

    // Measured rather than computed in code: this is what actually rendered, so
    // the checks verify the artifact instead of our intentions about it.
    //
    // No inner function declarations here on purpose. The bundler wraps named
    // functions in a `__name` helper for stack traces, and that helper does not
    // exist inside the page — so colour parsing happens in Node instead.
    const raw = (await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-cq-role]')).map((node) => {
        const el = node as HTMLElement
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        const img = el as HTMLImageElement
        return {
          role: el.dataset.cqRole ?? '',
          line: el.dataset.cqLine ?? el.dataset.cqRole ?? '',
          box: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
          text: el.tagName === 'IMG' ? undefined : (el.textContent ?? '').trim() || undefined,
          fontFamily: el.tagName === 'IMG' ? undefined : s.fontFamily,
          colourStrings: [s.color, s.backgroundColor, s.borderTopColor],
          src: el.tagName === 'IMG' ? (img.getAttribute('src') ?? undefined) : undefined,
          naturalWidth: el.tagName === 'IMG' ? img.naturalWidth : undefined,
          naturalHeight: el.tagName === 'IMG' ? img.naturalHeight : undefined,
        }
      }),
    )) as RawMeasured[]

    const elements: MeasuredElement[] = raw.map((el) => ({
      role: el.role as MeasuredElement['role'],
      line: el.line,
      box: el.box,
      text: el.text,
      fontFamily: el.fontFamily?.replace(/["']/g, '').split(',')[0].trim(),
      familySlug: faceToFamilySlug(el.fontFamily?.replace(/["']/g, '').split(',')[0].trim()),
      // An <img> reports an inherited `color` that means nothing. Harvesting it
      // made palette conformance flag a colour the logo never draws.
      colours:
        el.role === 'logo'
          ? []
          : [...new Set(el.colourStrings.map(cssColourToHex).filter((c): c is string => c !== null))],
      src: el.src,
      naturalWidth: el.naturalWidth,
      naturalHeight: el.naturalHeight,
    }))

    const png = await page.screenshot({ type: 'png' })
    await page.close()

    const loadedFaces = Object.entries(faceStatus).filter(([, ok]) => ok).map(([f]) => f)
    const missingFaces = Object.entries(faceStatus).filter(([, ok]) => !ok).map(([f]) => f)

    return { raster: decodePng(png), png, loadedFaces, missingFaces, computed, elements }
  } finally {
    if (owned) await browser.close()
  }
}

/**
 * Every text element renders in a face the brain shipped.
 *
 * A computed family that isn't one of ours means the browser silently fell back,
 * which is a hard failure rather than a warning: the render will look fine and the
 * type will be wrong.
 */
export function verifyFonts(result: RenderResult): { ok: boolean; problems: string[] } {
  const problems: string[] = []

  // A declared-but-unreferenced face legitimately never loads — browsers only
  // fetch faces something actually uses. Only the ones in use are evidence.
  const inUse = new Set(
    result.computed.map((el) => el.family.replace(/["']/g, '').split(',')[0].trim()),
  )
  for (const face of result.missingFaces) {
    if (inUse.has(face)) {
      problems.push(`face "${face}" is used but was never loaded by the browser`)
    }
  }

  for (const el of result.computed) {
    const family = el.family.replace(/["']/g, '').split(',')[0].trim()
    if (!family.startsWith('brain-')) {
      problems.push(
        `${el.line} rendered in "${family}", which is not a face from the brain — ` +
          'this is a silent fallback',
      )
    } else if (result.missingFaces.includes(family)) {
      problems.push(`${el.line} asks for "${family}", which did not load`)
    }
  }

  return { ok: problems.length === 0, problems }
}

export const launchBrowser = () => chromium.launch()
