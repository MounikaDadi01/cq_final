import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import {
  declaredFamilies,
  loadBrain,
  normaliseHex,
  recoverMissingKind,
  resolveFamily,
  selfContradictions,
} from './brain'

/**
 * Plans the ingest of a brain directory: what to upload, what rows to write, and
 * what is wrong with the input.
 *
 * A pure function on purpose. It touches no bucket and no database, so it is
 * testable before either exists and the backend's job reduces to executing the
 * plan. Nothing here names a customer: identity comes from the manifest, and a
 * brand nobody has seen plans identically.
 *
 * Findings are produced once, here, rather than rediscovered by every run.
 */

export type Severity = 'info' | 'review' | 'blocked'

export interface IngestFinding {
  code: string
  severity: Severity
  detail: string
}

export interface IngestObject {
  /** Where it lands: <kitId>/<path within the brain>. */
  storageKey: string
  sourcePath: string
  sha256: string
  bytes: number
}

export interface IngestAsset {
  kind: string
  manifestPath: string
  storageKey: string | null
  /** The kit the manifest entry claims, which is not always the brain's own. */
  kitId: string
  /** False when the asset must never be offered to this kit. */
  available: boolean
  reason?: string
}

export interface IngestFont {
  familySlug: string
  weight: number
  style: string
  storageKey: string
}

export interface FamilyPlan {
  declared: string
  resolvedFamilySlug: string | null
  weight: number | null
  substituted: boolean
}

export interface IngestPlan {
  ok: boolean
  kitId: string
  sourceDir: string
  objects: IngestObject[]
  assets: IngestAsset[]
  fonts: IngestFont[]
  families: FamilyPlan[]
  findings: IngestFinding[]
}

const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/** Files that are never offered to a sandbox, even though they are stored. */
const WITHHELD_FROM_RUNS = ['brand/tokens.json']

function walkFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (IGNORED_FILES.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

const toPosix = (value: string) => value.split(sep).join(posix.sep)

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Compares a machine-readable token export against the authoritative document.
 * Generic: it walks whatever keys both happen to share.
 */
function tokenConflicts(dir: string, brain: ReturnType<typeof loadBrain>): IngestFinding[] {
  const tokensPath = join(dir, 'brand', 'tokens.json')
  if (!existsSync(tokensPath)) return []

  let tokens: Record<string, unknown>
  try {
    tokens = JSON.parse(readFileSync(tokensPath, 'utf8'))
  } catch {
    return [
      {
        code: 'token-cache-unreadable',
        severity: 'review',
        detail: 'brand/tokens.json is not valid JSON; it has no authority so ingest continues',
      },
    ]
  }

  const findings: IngestFinding[] = []

  const palette = (tokens.palette ?? {}) as Record<string, string>
  for (const [key, raw] of Object.entries(palette)) {
    const cached = normaliseHex(String(raw))
    const authoritative = brain.palette[key.toLowerCase()]
    if (cached && authoritative && cached !== authoritative) {
      findings.push({
        code: 'token-cache-conflict',
        severity: 'review',
        detail: `palette.${key}: cache says ${cached}, DESIGN.md says ${authoritative} — DESIGN.md wins`,
      })
    }
  }

  const scale = (tokens.type_scale ?? {}) as Record<string, string>
  for (const [key, raw] of Object.entries(scale)) {
    const authoritative = brain.typeScale[key.toLowerCase()]
    if (authoritative && String(raw).trim() !== authoritative) {
      findings.push({
        code: 'token-cache-conflict',
        severity: 'review',
        detail: `type_scale.${key}: cache says ${raw}, DESIGN.md says ${authoritative} — DESIGN.md wins`,
      })
    }
  }

  const radii = tokens.radii
  const shape = brain.shape['border-radius']
  if (Array.isArray(radii) && shape && !radii.map(String).includes(shape)) {
    findings.push({
      code: 'token-cache-conflict',
      severity: 'review',
      detail: `radii ${JSON.stringify(radii)} does not include DESIGN.md's ${shape} — DESIGN.md wins`,
    })
  }

  return findings
}

export function planIngest(dir: string): IngestPlan {
  const findings: IngestFinding[] = []
  const empty = (reason: IngestFinding): IngestPlan => ({
    ok: false,
    kitId: '',
    sourceDir: dir,
    objects: [],
    assets: [],
    fonts: [],
    families: [],
    findings: [reason],
  })

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return empty({ code: 'not-a-directory', severity: 'blocked', detail: `${dir} is not a directory` })
  }
  if (!existsSync(join(dir, 'DESIGN.md'))) {
    return empty({
      code: 'no-design-doc',
      severity: 'blocked',
      detail: 'DESIGN.md is the brand; a brain without one cannot be ingested',
    })
  }
  if (!existsSync(join(dir, 'brand', 'asset_manifest.json'))) {
    return empty({
      code: 'no-asset-manifest',
      severity: 'blocked',
      detail: 'brand/asset_manifest.json carries the kit id; without it the kit has no identity',
    })
  }

  const brain = loadBrain(dir)

  // A palette nobody could read is not the same as a brand with no colours, and
  // until now the second case was silent: a document titled "## Colours" produced an
  // empty palette, no finding, and a render that fell back to black and white looking
  // entirely deliberate.
  if (Object.keys(brain.palette).length === 0 && Object.keys(brain.unparsedPalette).length === 0) {
    findings.push({
      code: 'palette-not-found',
      severity: 'review',
      detail:
        'no palette could be read from DESIGN.md — check the section heading. Without one, ' +
        'text colour falls back to black and white, which is off-brand and looks intentional',
    })
  }


  if (!brain.kitId) {
    return empty({
      code: 'no-kit-id',
      severity: 'blocked',
      detail: 'the manifest declares no brand_kit_id',
    })
  }

  // Identity comes from the manifest. Folder names are not authority — this
  // packet contains an asset whose folder and whose kit disagree, and trusting
  // the folder is how a competitor's mark reaches the wrong canvas.
  findings.push({
    code: 'kit-id-from-manifest',
    severity: 'info',
    detail: `kit id "${brain.kitId}" read from the manifest, not from the folder name "${brain.slug}"`,
  })
  if (brain.slug.toLowerCase() !== brain.kitId.toLowerCase()) {
    findings.push({
      code: 'folder-name-differs-from-kit',
      severity: 'info',
      detail: `folder "${brain.slug}" does not match kit "${brain.kitId}"; the manifest governs`,
    })
  }

  const objects: IngestObject[] = walkFiles(dir).map((sourcePath) => {
    const rel = toPosix(relative(dir, sourcePath))
    return {
      storageKey: `${brain.kitId}/${rel}`,
      sourcePath,
      sha256: sha256(sourcePath),
      bytes: statFileSize(sourcePath),
    }
  })

  const keyFor = (manifestPath: string) => `${brain.kitId}/${toPosix(manifestPath)}`

  // Two files could each stand in for a missing reverse logo. Measurement got as
  // far as narrowing it and no further, so it is reported and left unresolved
  // rather than decided by ordering.
  const ambiguous = recoverMissingKind(brain)
  if (ambiguous && 'ambiguous' in ambiguous) {
    findings.push({
      code: 'asset-reverse-ambiguous',
      severity: 'review',
      detail:
        `"logo_reverse" has no file, and ${ambiguous.ambiguous.length} files could each be it ` +
        `(${ambiguous.ambiguous.map((c) => c.path).join(', ')}) — left unresolved, because ` +
        'choosing between them is a judgment about the brand and not a measurement',
    })
  }

  const assets: IngestAsset[] = brain.assets.map((asset) => {
    if (!asset.exists) {
      findings.push({
        code: 'asset-missing-file',
        severity: 'review',
        detail: `${asset.path} is listed as "${asset.kind}" but no file exists — a path is not an asset`,
      })
      return {
        kind: asset.kind,
        manifestPath: asset.path,
        storageKey: null,
        kitId: asset.kitId,
        available: false,
        reason: 'no file behind the manifest entry',
      }
    }

    if (asset.kitId !== brain.kitId) {
      // Stored and recorded, never offered. Keeping the object preserves the
      // evidence; withholding it is what stops the leak.
      findings.push({
        code: 'asset-foreign-kit',
        severity: 'review',
        detail:
          `${asset.path} is tagged ${asset.kitId} but sits in the brain for ${brain.kitId} — ` +
          'quarantined, and never offered to this kit',
      })
      return {
        kind: asset.kind,
        manifestPath: asset.path,
        storageKey: keyFor(asset.path),
        kitId: asset.kitId,
        available: false,
        reason: `belongs to ${asset.kitId}`,
      }
    }

    if (asset.resolvedFrom) {
      /**
       * The manifest named a file that is not in the kit, and another file was
       * measured to be that same mark recoloured for a dark ground. Recorded as a
       * review finding rather than passed over in silence: this is a correction to
       * the customer's own data, so it has to be visible and checkable even though
       * the evidence is strong.
       */
      findings.push({
        code: 'asset-reverse-recovered',
        severity: 'review',
        detail:
          `${asset.path} is listed as "${asset.kind}" but no file exists; ` +
          `${asset.resolvedFrom.path} was used instead — ${asset.resolvedFrom.reason}`,
      })
      return {
        kind: asset.kind,
        manifestPath: asset.path,
        // The key has to point at the file that exists, not the one declared.
        storageKey: keyFor(asset.resolvedFrom.path),
        kitId: asset.kitId,
        available: true,
      }
    }

    return {
      kind: asset.kind,
      manifestPath: asset.path,
      storageKey: keyFor(asset.path),
      kitId: asset.kitId,
      available: true,
    }
  })

  const fonts: IngestFont[] = brain.fonts.map((font) => ({
    familySlug: font.familySlug,
    weight: font.weight,
    style: font.style,
    storageKey: `${brain.kitId}/fonts/${font.file}`,
  }))

  if (fonts.length === 0) {
    findings.push({
      code: 'no-fonts',
      severity: 'review',
      detail: 'the brain ships no font files; browser fallback is not the brand',
    })
  }

  const families: FamilyPlan[] = declaredFamilies(brain).map((declared) => {
    const resolution = resolveFamily(brain, declared)
    if (resolution.resolvedFamilySlug === null) {
      findings.push({
        code: 'font-unresolvable',
        severity: 'review',
        detail: resolution.reason ?? `no shipped family matches "${declared}"`,
      })
    } else if (resolution.substituted) {
      findings.push({
        code: 'font-substituted',
        severity: 'review',
        detail: resolution.reason ?? `"${declared}" substituted`,
      })
    }
    return {
      declared,
      resolvedFamilySlug: resolution.resolvedFamilySlug,
      weight: resolution.weight,
      substituted: resolution.substituted,
    }
  })

  // Input we could not turn into machine-readable values. None of these block:
  // the files hydrate in full and the agent reads DESIGN.md regardless. They are
  // recorded so nothing is dropped in silence and a person can decide whether
  // the gap matters.
  for (const file of brain.unparsedFonts) {
    findings.push({
      code: 'font-filename-unrecognised',
      severity: 'review',
      detail:
        `fonts/${file} does not follow family_weight_style, so it is not indexed. ` +
        'It still hydrates with the rest of the directory and the agent can use it.',
    })
  }

  for (const [key, raw] of Object.entries(brain.unparsedPalette)) {
    findings.push({
      code: 'palette-value-not-machine-readable',
      severity: 'review',
      detail:
        `palette.${key} is "${raw}", which software cannot compare. ` +
        'Colour checks for it report unverifiable rather than passing; the agent reads DESIGN.md.',
    })
  }

  for (const asset of brain.assets) {
    if (asset.exists && (!asset.naturalWidth || !asset.naturalHeight)) {
      findings.push({
        code: 'svg-no-intrinsic-size',
        severity: 'review',
        detail:
          `${asset.path} declares no width, height or viewBox, so its natural proportions ` +
          'are unknown and a squashed placement cannot be detected automatically.',
      })
    }
  }

  for (const contradiction of selfContradictions(brain)) {
    findings.push({
      code: 'design-doc-self-conflict',
      severity: 'review',
      detail:
        `DESIGN.md states ${contradiction.key} twice: ${contradiction.detail}. ` +
        `Resolved to ${contradiction.value}, deterministically, so every run agrees.`,
    })
  }

  findings.push(...tokenConflicts(dir, brain))

  for (const withheld of WITHHELD_FROM_RUNS) {
    if (objects.some((o) => o.storageKey === `${brain.kitId}/${withheld}`)) {
      findings.push({
        code: 'withheld-from-runs',
        severity: 'info',
        detail: `${withheld} is stored for the record but never hydrated into a run — it has no authority`,
      })
    }
  }

  return {
    ok: true,
    kitId: brain.kitId,
    sourceDir: dir,
    objects,
    assets,
    fonts,
    families,
    findings,
  }
}

/** Assets a run may actually be offered: this kit's own, resolving to a file. */
export function availableAssets(plan: IngestPlan): IngestAsset[] {
  return plan.assets.filter((a) => a.available)
}

/** Anything a person should look at before trusting the kit. */
export function reviewFindings(plan: IngestPlan): IngestFinding[] {
  return plan.findings.filter((f) => f.severity !== 'info')
}

export function isBlocked(plan: IngestPlan): boolean {
  return !plan.ok || plan.findings.some((f) => f.severity === 'blocked')
}

function statFileSize(path: string): number {
  return statSync(path).size
}
