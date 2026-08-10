import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Loads a brain directory generically.
 *
 * Note the division of labour, because it looks like a contradiction otherwise:
 * the *backend* never parses `DESIGN.md` — it ships the file and the agent
 * interprets it. The *evaluation layer* does parse it, because a test needs
 * ground truth to assert against. Neither one contains a brand name.
 */

export interface FontFile {
  file: string
  path: string
  familySlug: string
  weight: number
  style: string
}

export interface BrandAsset {
  kind: string
  path: string
  kitId: string
  absolutePath: string
  exists: boolean
  /** Intrinsic size read from the SVG header, when declared. */
  naturalWidth?: number
  naturalHeight?: number
}

export interface Brain {
  dir: string
  /** Directory name. Used to discover tenant names without hardcoding any. */
  slug: string
  kitId: string
  palette: Record<string, string>
  type: Record<string, string>
  typeScale: Record<string, string>
  shape: Record<string, string>
  fonts: FontFile[]
  assets: BrandAsset[]
  designDoc: string
}

/** #abc and #AABBCC both normalise to #AABBCC. */
export function normaliseHex(value: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (!m) return null
  const h = m[1]
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return `#${full.toUpperCase()}`
}

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/**
 * Reads `- key: value` pairs under a `## Heading` from a markdown document.
 * Trailing parenthetical notes are kept out of the value.
 */
export function readSection(markdown: string, heading: string): Record<string, string> {
  const lines = markdown.split(/\r?\n/)
  const out: Record<string, string> = {}
  let inside = false
  for (const line of lines) {
    const h = /^##\s+(.*)$/.exec(line)
    if (h) {
      inside = h[1].trim().toLowerCase() === heading.trim().toLowerCase()
      continue
    }
    if (!inside) continue
    const kv = /^-\s*([^:]+):\s*(.+)$/.exec(line)
    if (kv) {
      const key = kv[1].trim().toLowerCase()
      const value = kv[2].trim().replace(/\s*\(.*\)\s*$/, '').trim()
      out[key] = value
    }
  }
  return out
}

function parseFontFile(file: string, dir: string): FontFile | null {
  const stem = file.replace(/\.[^.]+$/, '')
  const parts = stem.split('_')
  if (parts.length < 3) return null
  const style = parts[parts.length - 1]
  const weight = Number(parts[parts.length - 2])
  if (!Number.isFinite(weight)) return null
  const familySlug = parts.slice(0, parts.length - 2).join('_')
  return { file, path: join(dir, file), familySlug, weight, style }
}

function readSvgIntrinsic(path: string): { naturalWidth?: number; naturalHeight?: number } {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 2000)
    const w = /\bwidth="(\d+(?:\.\d+)?)"/.exec(head)
    const h = /\bheight="(\d+(?:\.\d+)?)"/.exec(head)
    if (w && h) return { naturalWidth: Number(w[1]), naturalHeight: Number(h[1]) }
    const vb = /viewBox="\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/.exec(head)
    if (vb) return { naturalWidth: Number(vb[1]), naturalHeight: Number(vb[2]) }
  } catch {
    /* unreadable is reported through `exists` */
  }
  return {}
}

export function loadBrain(dir: string): Brain {
  const designPath = join(dir, 'DESIGN.md')
  if (!existsSync(designPath)) throw new Error(`no DESIGN.md in ${dir}`)
  const designDoc = readFileSync(designPath, 'utf8')

  const rawPalette = readSection(designDoc, 'Palette')
  const palette: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawPalette)) {
    const hex = normaliseHex(v)
    if (hex) palette[k] = hex
  }

  const fontsDir = join(dir, 'fonts')
  const fonts: FontFile[] = existsSync(fontsDir)
    ? readdirSync(fontsDir)
        .filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
        .map((f) => parseFontFile(f, fontsDir))
        .filter((f): f is FontFile => f !== null)
    : []

  const manifestPath = join(dir, 'brand', 'asset_manifest.json')
  let kitId = ''
  let assets: BrandAsset[] = []
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    kitId = manifest.brand_kit_id ?? ''
    assets = (manifest.assets ?? []).map((a: Record<string, string>) => {
      const absolutePath = join(dir, a.path)
      const exists = existsSync(absolutePath) && statSync(absolutePath).isFile()
      return {
        kind: a.kind,
        path: a.path,
        kitId: a.brand_kit_id ?? '',
        absolutePath,
        exists,
        ...(exists ? readSvgIntrinsic(absolutePath) : {}),
      }
    })
  }

  return {
    dir,
    slug: basename(dir),
    kitId,
    palette,
    type: readSection(designDoc, 'Type'),
    typeScale: readSection(designDoc, 'Type scale'),
    shape: readSection(designDoc, 'Shape'),
    fonts,
    assets,
    designDoc,
  }
}

/** Every immediate subdirectory holding a DESIGN.md is a brain. */
export function discoverBrains(root: string): Brain[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'DESIGN.md')))
    .map(loadBrain)
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/** The families a brain actually ships, as slugs. */
export function availableFamilies(brain: Brain): string[] {
  return [...new Set(brain.fonts.map((f) => f.familySlug))].sort()
}

export interface FamilyResolution {
  requested: string
  resolvedFamilySlug: string | null
  weight: number | null
  substituted: boolean
  reason?: string
}

/**
 * Generic font resolution. No rule here names a family.
 *
 * An exact slug match resolves directly. Otherwise the longest available slug
 * that prefixes the request wins, at the heaviest weight shipped — so a brain
 * naming "<Family> Condensed" while shipping only "<Family>" is handled by the
 * same sentence as any other brain.
 */
export function resolveFamily(brain: Brain, requested: string): FamilyResolution {
  const want = slugify(requested)
  const available = availableFamilies(brain)

  const heaviest = (slug: string) =>
    Math.max(...brain.fonts.filter((f) => f.familySlug === slug).map((f) => f.weight))

  if (available.includes(want)) {
    return { requested, resolvedFamilySlug: want, weight: heaviest(want), substituted: false }
  }

  const prefixes = available
    .filter((slug) => want.startsWith(slug + '_') || want === slug)
    .sort((a, b) => b.length - a.length)

  if (prefixes.length > 0) {
    const slug = prefixes[0]
    return {
      requested,
      resolvedFamilySlug: slug,
      weight: heaviest(slug),
      substituted: true,
      reason: `no file for "${requested}"; nearest shipped family "${slug}" at weight ${heaviest(slug)}`,
    }
  }

  return {
    requested,
    resolvedFamilySlug: null,
    weight: null,
    substituted: false,
    reason: `no shipped family matches "${requested}"; browser fallback is not the brand`,
  }
}

/** Families named in DESIGN.md's Type section, in declaration order. */
export function declaredFamilies(brain: Brain): string[] {
  return [...new Set(Object.values(brain.type))]
}
