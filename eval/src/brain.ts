import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { relativeLuminance } from './png'

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
  /**
   * The manifest's own note on this asset.
   *
   * Load-bearing, not decoration: one kit states its reverse-logo switch point
   * here as a colour ("any ground darker than #6B7A88"). A brand that tells you
   * its own threshold should not be second-guessed by a constant of ours.
   */
  notes?: string
  /**
   * Set when the manifest's path had no file and another file in the kit was
   * measured to be this exact asset, recoloured.
   *
   * `path` stays the manifest's own claim so the declaration is preserved; this
   * records what was actually used and on what evidence. Both are needed: the
   * report has to be able to say "you listed X, we used Y, here is why".
   */
  resolvedFrom?: { path: string; reason: string }
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
  /** False when the kit ships no DESIGN.md at all, which nothing can work around. */
  hasDesignDoc: boolean

  /**
   * Input we could not turn into machine-readable values.
   *
   * These exist so nothing is dropped silently. A brand naming its colours in
   * Pantone, or shipping `Family-Regular.ttf` instead of `family_400_normal.ttf`,
   * is not broken — it is just not comparable by software. The files still
   * hydrate in full and the agent still reads `DESIGN.md`; what changes is that
   * checks depending on these values report *unverifiable* rather than passing
   * for the wrong reason.
   */
  unparsedFonts: string[]
  unparsedPalette: Record<string, string>
}

/** #abc and #AABBCC both normalise to #AABBCC. */
/**
 * Colour forms a person actually writes.
 *
 * `#RRGGBB` is the easy case. `rgb(30, 41, 59)` appears whenever a print vendor is
 * involved, and refusing it means an entire palette is unreadable for a formatting
 * reason rather than a substantive one. A named colour system like Pantone stays
 * unreadable on purpose: there is no correct conversion, and guessing one would put
 * a wrong colour on a customer's ad with no warning.
 */
export function normaliseHex(value: string): string | null {
  const text = value.trim()

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return `#${full.toUpperCase()}`
  }

  // `rgb(30, 41, 59)` turns up whenever a print vendor is involved. Refusing it makes
  // a whole palette unreadable for a formatting reason rather than a substantive one.
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)$/i.exec(text)
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((n) => Number(n))
    if (parts.every((n) => n >= 0 && n <= 255)) {
      return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`
    }
  }

  // A named colour system stays unreadable on purpose. There is no correct conversion
  // from Pantone to sRGB, and guessing one would put a wrong colour on a customer's
  // ad with nothing to say so — which is worse than reporting that it is unreadable.
  return null
}

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

/**
 * Reads `- key: value` pairs under a `## Heading` from a markdown document.
 * Trailing parenthetical notes are kept out of the value.
 */
/**
 * Headings that mean the same thing.
 *
 * A brand document is written by a person, not generated, so the same section
 * arrives titled differently: "Colours", "Colors", "Palette". Matching one exact
 * string meant a kit whose author wrote "## Colours" produced an *empty* palette —
 * silently, with no finding, and the render then fell back to black and white,
 * which is off-brand and looks deliberate.
 *
 * These are synonyms of a concept, not a list of customers. A fifth brand inventing
 * a sixth word for colour still needs no code change to be *reported*; it just needs
 * one to be understood, and being reported is the part that matters.
 */
const HEADING_ALIASES: Record<string, string[]> = {
  palette: ['palette', 'colours', 'colors', 'colour', 'color'],
  type: ['type', 'typography', 'typefaces', 'fonts'],
  'type scale': ['type scale', 'scale', 'type sizes', 'sizes'],
  shape: ['shape', 'shapes', 'geometry', 'radii'],
}

export function readSection(markdown: string, heading: string): Record<string, string> {
  const want = heading.trim().toLowerCase()
  const accepted = HEADING_ALIASES[want] ?? [want]
  const lines = markdown.split(/\r?\n/)
  const out: Record<string, string> = {}
  let inside = false
  for (const line of lines) {
    const h = /^##\s+(.*)$/.exec(line)
    if (h) {
      inside = accepted.includes(h[1].trim().toLowerCase())
      continue
    }
    if (!inside) continue
    const kv = /^-\s*([^:]+):\s*(.+)$/.exec(line)
    if (kv) {
      const key = kv[1].trim().toLowerCase()
      /**
       * Strip a trailing note, not a function call.
       *
       * The intent was `primary: #1B3A5C (navy)` → `#1B3A5C`. The pattern also ate
       * `rgb(30, 41, 59)` down to `rgb`, so a palette written in RGB — which happens
       * whenever a print vendor is involved — came back entirely unreadable and the
       * cause was invisible.
       *
       * A note is separated by whitespace; a function's bracket is not. That one
       * character distinguishes them.
       */
      const value = kv[2].trim().replace(/\s+\([^()]*\)\s*$/, '').trim()
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
  /**
   * A missing DESIGN.md loads as an empty brand rather than throwing.
   *
   * Throwing here meant a kit without one could not be inspected at all: it never
   * appeared, and the blocker ingest already has for exactly this case could never
   * fire. Loading it empty lets the whole pipeline say clearly what is wrong — no
   * palette, no type, no scale — instead of the directory silently not existing.
   *
   * `hasDesignDoc` is on the result so nothing downstream has to infer it from an
   * empty palette, which could also mean a badly titled section.
   */
  const designPath = join(dir, 'DESIGN.md')
  const hasDesignDoc = existsSync(designPath)
  const designDoc = hasDesignDoc ? readFileSync(designPath, 'utf8') : ''

  const rawPalette = readSection(designDoc, 'Palette')
  const palette: Record<string, string> = {}
  const unparsedPalette: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawPalette)) {
    const hex = normaliseHex(v)
    if (hex) palette[k] = hex
    else unparsedPalette[k] = v
  }

  const fontsDir = join(dir, 'fonts')
  const fontFiles = existsSync(fontsDir)
    ? readdirSync(fontsDir).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f))
    : []
  const fonts: FontFile[] = []
  const unparsedFonts: string[] = []
  for (const file of fontFiles) {
    const parsed = parseFontFile(file, fontsDir)
    if (parsed) fonts.push(parsed)
    else unparsedFonts.push(file)
  }

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
        ...(a.notes ? { notes: a.notes } : {}),
        ...(exists ? readSvgIntrinsic(absolutePath) : {}),
      }
    })
  }

  const brain: Brain = {
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
    hasDesignDoc,
    unparsedFonts,
    unparsedPalette,
  }

  /**
   * Recover a declared reverse logo whose file is filed under another name.
   *
   * Done here rather than at each call site so every consumer sees one truth: the
   * renderer, the checks and the ingest planner all read `brain.assets`, and a
   * recovery visible to only some of them would mean the ad and the report
   * disagree about which file was used.
   *
   * The manifest's `path` is left alone and `resolvedFrom` carries what was
   * actually used, so nothing here erases what the customer declared.
   */
  const recovered = recoverMissingKind(brain)
  if (recovered && 'candidate' in recovered) {
    const declared = brain.assets.find(
      (a) => a.kind === 'logo_reverse' && a.kitId === brain.kitId,
    )!
    declared.absolutePath = recovered.candidate.absolutePath
    declared.exists = true
    declared.resolvedFrom = {
      path: recovered.candidate.path,
      reason: recovered.candidate.reason,
    }
    Object.assign(declared, readSvgIntrinsic(recovered.candidate.absolutePath))
  }

  return brain
}

/**
 * The drawing elements of an SVG, in order, with their geometry and without any
 * colour.
 *
 * Two files with the same skeleton draw the same shapes in the same places. That
 * is the whole basis of reverse-variant recovery below, and it is deliberately a
 * structural comparison rather than a filename one.
 */
export function svgSkeleton(svg: string): string[] {
  return [...svg.matchAll(/<(path|circle|rect|polygon|ellipse|line|text|polyline)\b([^>]*)>/g)].map(
    ([, tag, attrs]) => {
      const geometry = [...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)]
        .filter(([, name]) => name !== 'fill' && name !== 'stroke')
        .map(([, name, value]) => `${name}=${value}`)
        .sort()
      return `${tag}(${geometry.join(',')})`
    },
  )
}

const svgFills = (svg: string) => [...svg.matchAll(/fill="([^"]*)"/g)].map(([, value]) => value)

export interface ReverseCandidate {
  /** Manifest path of the file that could stand in. */
  path: string
  absolutePath: string
  /** The kind it is currently registered as, which is what made it invisible. */
  registeredAs: string
  reason: string
}

/**
 * Files in this kit that are the primary logo recoloured for a dark ground.
 *
 * Why this exists: one kit in the packet ships its reverse logo under a name that
 * describes something else, so the manifest's `logo_reverse` path has no file and
 * a dark-ground ad has no legible mark to place. The remedy has to be measured,
 * because inferring it from the filename would be a guess about one brand — and a
 * wrong guess here puts the wrong mark on a customer's ad.
 *
 * A candidate must satisfy all three:
 *
 *   1. identical skeleton to the primary logo — same elements, same geometry, so
 *      it is the same drawing and not merely a similar one;
 *   2. the same accessible label, so a file naming a second party is excluded;
 *   3. the fills that changed move toward the palette's light extreme, which is
 *      what "reverse" means and what distinguishes it from a recolour into some
 *      other brand colour.
 *
 * Condition 1 is the one that does the real work, and it was arrived at by
 * disproving a weaker rule. Matching on geometry plus label alone accepted a
 * genuine co-brand lockup, whose wordmark path is identical to the primary and
 * which merely has a partner's name added beside it. Requiring the *whole*
 * element list to match rejects it, because those extra elements are exactly what
 * make it a lockup rather than a variant.
 *
 * Returns every match. One is resolvable; several is a judgment call and stays
 * unresolved, because choosing between two plausible marks is not a measurement.
 */
export function reverseCandidates(brain: Brain, primaryKind = 'logo'): ReverseCandidate[] {
  const primary = brain.assets.find(
    (a) => a.kind === primaryKind && a.kitId === brain.kitId && a.exists,
  )
  const extremes = paletteExtremes(brain)
  if (!primary || !extremes) return []

  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }
  const primarySvg = read(primary.absolutePath)
  if (!primarySvg) return []

  const primarySkeleton = svgSkeleton(primarySvg).join('|')
  const primaryFills = svgFills(primarySvg)
  const primaryLabel = /aria-label="([^"]*)"/.exec(primarySvg)?.[1] ?? null
  const lightest = relativeLuminance(extremes.lightest)
  const darkest = relativeLuminance(extremes.darkest)
  // A palette with no spread cannot express "toward the light extreme" at all.
  if (lightest - darkest < 0.05) return []

  /**
   * Scan files on disk, not manifest entries.
   *
   * This is the whole reason the first implementation found nothing. A misfiled
   * asset is by definition one the manifest does not describe correctly: the file
   * in question is declared in *another* kit's manifest, and ingest uploads bytes
   * under the prefix of the kit that owns them. So after ingest the file sits in
   * this kit's folder while this kit's manifest has never heard of it, and
   * iterating `brain.assets` cannot see it by construction.
   *
   * Scanning also means a declared file gets no special treatment — the co-brand
   * lockup that must be rejected is declared, and it is rejected on its contents.
   */
  const svgFiles: { path: string; absolutePath: string }[] = []
  for (const folder of ['brand', '']) {
    const base = folder ? join(brain.dir, folder) : brain.dir
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      if (!/\.svg$/i.test(name)) continue
      const absolutePath = join(base, name)
      if (!statSync(absolutePath).isFile()) continue
      svgFiles.push({ path: folder ? `${folder}/${name}` : name, absolutePath })
    }
  }

  const candidates: ReverseCandidate[] = []
  for (const file of svgFiles) {
    if (file.absolutePath === primary.absolutePath) continue
    const svg = read(file.absolutePath)
    if (!svg) continue
    const asset = {
      path: file.path,
      absolutePath: file.absolutePath,
      kind: brain.assets.find((a) => a.path === file.path)?.kind ?? '(undeclared)',
    }

    if (svgSkeleton(svg).join('|') !== primarySkeleton) continue
    if ((/aria-label="([^"]*)"/.exec(svg)?.[1] ?? null) !== primaryLabel) continue

    const fills = svgFills(svg)
    if (fills.length !== primaryFills.length) continue
    const changed = primaryFills
      .map((before, i) => [before, fills[i]] as const)
      .filter(([before, after]) => before !== after)
    if (!changed.length) continue

    // Every changed fill has to get lighter, and at least one has to land at or
    // near the palette's light extreme. A recolour into a mid-tone is a different
    // treatment, not a reverse.
    const luminances = changed.map(([before, after]) => {
      const b = normaliseHex(before)
      const a = normaliseHex(after)
      return b && a ? ([relativeLuminance(b), relativeLuminance(a)] as const) : null
    })
    if (luminances.some((pair) => pair === null)) continue
    const pairs = luminances as (readonly [number, number])[]
    const brightened = pairs.filter(([b, a]) => a > b)
    if (!brightened.length) continue
    if (!brightened.some(([, a]) => a >= lightest - 0.05)) continue

    candidates.push({
      path: asset.path,
      absolutePath: asset.absolutePath,
      registeredAs: asset.kind,
      reason:
        `identical element skeleton to "${primaryKind}" (${svgSkeleton(svg).length} elements) and the ` +
        `same label ${primaryLabel === null ? '(none)' : `"${primaryLabel}"`}; ` +
        changed
          .map(([before, after]) => `${before} → ${after}`)
          .join(', ') +
        `, moving toward the palette's light extreme ${extremes.lightest}`,
    })
  }
  return candidates
}

/**
 * Resolves a declared-but-missing asset kind to a file measured to be it.
 *
 * Returns null when there is nothing to resolve, nothing that matches, or more
 * than one thing that matches. Ambiguity is not resolved silently: two candidates
 * means a person picks.
 */
export function recoverMissingKind(
  brain: Brain,
  kind = 'logo_reverse',
): { candidate: ReverseCandidate; declaredPath: string } | { ambiguous: ReverseCandidate[] } | null {
  const declared = brain.assets.find((a) => a.kind === kind && a.kitId === brain.kitId)
  if (!declared || declared.exists) return null
  const candidates = reverseCandidates(brain)
  if (candidates.length === 0) return null
  if (candidates.length > 1) return { ambiguous: candidates }
  return { candidate: candidates[0], declaredPath: declared.path }
}

/** True when the palette cannot be compared by software at all. */
export function paletteIsMachineReadable(brain: Brain): boolean {
  return Object.keys(brain.palette).length > 0
}

/** True when some palette entries resisted parsing, so absence proves nothing. */
export function paletteIsPartial(brain: Brain): boolean {
  return Object.keys(brain.unparsedPalette).length > 0
}

export interface ScaleResolution {
  key: string
  value: string
  source: 'prose' | 'table'
  /** True when the document asserts two different values for the same key. */
  contested: boolean
  detail?: string
}

/**
 * Resolves a type-scale value when `DESIGN.md` contradicts itself.
 *
 * The precedence is SKILL.md's, not ours: the prose under *Applying it* is "as
 * binding as the numbers above them", and a statement scoped to every canvas is
 * more specific than a table entry. Where the prose asserts a value for a key
 * the table also states, the prose governs.
 *
 * Ties break deterministically on document order, so the same brain always
 * resolves the same way and a run is reproducible. Which value wins matters far
 * less than the resolution being recorded and repeatable.
 */
export function resolveScaleValue(brain: Brain, key: string): ScaleResolution | null {
  const tableValue = brain.typeScale[key.toLowerCase()]
  const proseValues = proseAssertionsFor(brain, key)

  if (proseValues.length === 0) {
    if (tableValue === undefined) return null
    return { key, value: tableValue, source: 'table', contested: false }
  }

  // First occurrence in document order is the deterministic winner.
  const prose = proseValues[0]
  const contested = tableValue !== undefined && tableValue !== prose
  return {
    key,
    value: prose,
    source: 'prose',
    contested,
    detail: contested
      ? `table says ${tableValue}, prose says ${prose}; prose governs and is more specific`
      : undefined,
  }
}

/**
 * Finds values the prose asserts for a scale key, in document order.
 *
 * Narrow by design: it looks for the key followed shortly by a pixel value. It
 * is only ever used to *report* a contradiction and to break a tie the same way
 * twice — the agent is what actually interprets the brand.
 */
function proseAssertionsFor(brain: Brain, key: string): string[] {
  const applying = sectionBody(brain.designDoc, 'Applying it')
  if (!applying) return []
  const pattern = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b[^.]{0,40}?(\\d+)\\s*px`, 'gi')
  const out: string[] = []
  for (const match of applying.matchAll(pattern)) out.push(`${match[1]}px`)
  return out
}

/** Raw text of a `## Heading` section, up to the next heading. */
export function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/)
  const body: string[] = []
  let inside = false
  for (const line of lines) {
    const h = /^##\s+(.*)$/.exec(line)
    if (h) {
      if (inside) break
      inside = h[1].trim().toLowerCase() === heading.trim().toLowerCase()
      continue
    }
    if (inside) body.push(line)
  }
  return inside || body.length > 0 ? body.join('\n') : null
}

/** Every scale key whose value the document states twice, differently. */
export function selfContradictions(brain: Brain): ScaleResolution[] {
  return Object.keys(brain.typeScale)
    .map((key) => resolveScaleValue(brain, key))
    .filter((r): r is ScaleResolution => r !== null && r.contested)
}

/** Every immediate subdirectory holding a DESIGN.md is a brain. */
export function discoverBrains(root: string): Brain[] {
  if (!existsSync(root)) return []
  /**
   * A directory that looks like a brain is discovered even when it is unusable.
   *
   * Requiring `DESIGN.md` here made a kit without one *invisible* rather than refused —
   * so a customer whose upload was missing the one file that matters saw nothing at all
   * and no explanation. Ingest already has a blocker for it; it could never fire,
   * because nothing ever reached ingest.
   *
   * "Looks like a brain" is a manifest or a DESIGN.md. Ingest decides whether it can be
   * used; discovery only decides whether it is worth looking at.
   */
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => statSync(p).isDirectory())
    .filter(
      (p) =>
        existsSync(join(p, 'DESIGN.md')) || existsSync(join(p, 'brand', 'asset_manifest.json')),
    )
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

/**
 * Which asset kind to reach for, by how dark the ground is.
 *
 * Policy as data, not code — in production this is a row, so a brand shipping a
 * kind nobody anticipated needs no edit here. On a dark ground the list stops at
 * two entries on purpose: if neither a reverse mark nor a symbol exists, the
 * answer is to omit and escalate, never to place a wordmark that will not read.
 */
export interface LogoPreference {
  dark: string[]
  light: string[]
}

export const DEFAULT_LOGO_PREFERENCE: LogoPreference = {
  dark: ['logo_reverse', 'logo_mark'],
  light: ['logo', 'logo_mark'],
}

/**
 * The luminance below which white type outreads black type. The crossover is
 * exact, which is why software is allowed to compute it.
 */
export const DARK_GROUND_LUMINANCE = 0.179

/**
 * The lightest and darkest colours a kit publishes, found by luminance.
 *
 * Replaces looking up the keys `surface` and `ink`. Those names happen to exist
 * in both kits here, so naming them worked on two brands and would have returned
 * `undefined` on a third that called them `background`/`foreground` — silently,
 * because an absent candidate simply means no correction is ever applied. A kit
 * that publishes any palette at all has a lightest and a darkest member.
 */
export function paletteExtremes(brain: Brain): { lightest: string; darkest: string } | null {
  const entries = Object.values(brain.palette).filter((hex) => /^#[0-9A-Fa-f]{6}$/.test(hex))
  if (!entries.length) return null
  const sorted = [...entries].sort((a, b) => relativeLuminance(a) - relativeLuminance(b))
  return { darkest: sorted[0], lightest: sorted[sorted.length - 1] }
}

/**
 * The luminance at which this kit says its reverse logo takes over.
 *
 * Read from the manifest note for the kind being placed, so a brand that states
 * its own switch point governs. Falls back to the computed crossover only when
 * the kit is silent.
 */
export function groundSwitchPoint(brain: Brain, kind = 'logo_reverse'): { value: number; source: string } {
  const note = brain.assets.find((a) => a.kind === kind && a.kitId === brain.kitId)?.notes
  const hex = note?.match(/#[0-9A-Fa-f]{6}/)?.[0]
  if (hex) {
    return { value: relativeLuminance(hex), source: `${kind} note names ${hex}` }
  }
  return { value: DARK_GROUND_LUMINANCE, source: 'no threshold stated by the kit; computed crossover' }
}

/**
 * How strongly each kind identifies the brand, as policy data rather than a rule
 * about any particular brand. A wordmark contains the name; a symbol does not, so
 * a viewer who does not already know the mark learns nothing from it. Used only to
 * break ties between candidate positions — never to override the ground.
 */
export const IDENTIFICATION_RANK: Record<string, number> = {
  logo: 0,
  logo_reverse: 0,
  logo_lockup: 1,
  logo_mark: 2,
}

export interface LogoChoice {
  asset: BrandAsset | null
  kind: string | null
  groundIsDark: boolean
  reason: string
}

/**
 * Chooses a logo for the ground it will sit on, using only this kit's own
 * staged assets that resolve to a file.
 *
 * No brand is named. In this packet one brand takes the reverse-logo branch and
 * the other takes the symbol branch, from the same sentence — which is the shape
 * of answer a third brand needs.
 */
export function chooseLogo(
  brain: Brain,
  groundLuminance: number,
  preference: LogoPreference = DEFAULT_LOGO_PREFERENCE,
): LogoChoice {
  const switchPoint = groundSwitchPoint(brain)
  const groundIsDark = groundLuminance < switchPoint.value
  const order = groundIsDark ? preference.dark : preference.light

  const usable = (kind: string) =>
    brain.assets.find((a) => a.kind === kind && a.kitId === brain.kitId && a.exists)

  for (const kind of order) {
    const asset = usable(kind)
    if (asset) {
      return {
        asset,
        kind,
        groundIsDark,
        reason:
          `ground luminance ${groundLuminance.toFixed(3)} is ` +
          `${groundIsDark ? 'dark' : 'light'} against ${switchPoint.value.toFixed(3)} ` +
          `(${switchPoint.source}); "${kind}" is the first usable kind in ${order.join(' → ')}`,
      }
    }
  }

  return {
    asset: null,
    kind: null,
    groundIsDark,
    reason:
      `ground luminance ${groundLuminance.toFixed(3)} is ${groundIsDark ? 'dark' : 'light'} ` +
      `against ${switchPoint.value.toFixed(3)} (${switchPoint.source}) but this kit stages none ` +
      `of ${order.join(', ')} — omit the logo and escalate rather than placing one that will ` +
      'not read, and never typeset a substitute',
  }
}
