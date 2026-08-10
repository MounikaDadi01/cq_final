import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  availableAssets,
  isBlocked,
  planIngest,
  reviewFindings,
  type IngestPlan,
} from '../src/ingest'
import { brains } from './fixtures'

const packetBrains = brains()
const temporaries: string[] = []

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaries.push(dir)
  return dir
}

const SQUARE_SVG = (fill: string, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80" viewBox="0 0 240 80" role="img" aria-label="${label}">` +
  `<rect width="240" height="80" fill="${fill}"/></svg>`

/**
 * Writes a brain that does not exist in the packet.
 *
 * Every test that uses it proves the same thing: an unseen brand ingests through
 * the same path, with no code aware of it. Names here are invented on purpose.
 */
interface SyntheticOptions {
  kitId?: string
  folderName?: string
  headingFamily?: string
  fontFiles?: string[]
  assets?: { kind: string; path: string; kitId?: string; write?: boolean }[]
  tokens?: Record<string, unknown> | null
  omitDesignDoc?: boolean
  omitManifest?: boolean
}

function writeSyntheticBrain(options: SyntheticOptions = {}): string {
  const {
    kitId = 'bk-northwind-2031',
    folderName = 'northwind',
    headingFamily = 'Ashgrove',
    fontFiles = ['ashgrove_400_normal.ttf', 'ashgrove_700_normal.ttf'],
    assets = [{ kind: 'logo', path: 'brand/northwind-logo.svg' }],
    tokens = null,
    omitDesignDoc = false,
    omitManifest = false,
  } = options

  const root = tempDir('cq-brain-')
  const dir = join(root, folderName)
  mkdirSync(join(dir, 'brand'), { recursive: true })
  mkdirSync(join(dir, 'fonts'), { recursive: true })

  if (!omitDesignDoc) {
    writeFileSync(
      join(dir, 'DESIGN.md'),
      `# Northwind - Design Brain\n\n` +
        `## Palette\n\n` +
        `- primary: #123456\n- accent: #FE7A11\n- surface: #FFFFFF\n- ink: #101418\n- muted: #6A7480\n\n` +
        `## Type\n\n- heading: ${headingFamily}\n- body: Ashgrove\n\n` +
        `## Type scale\n\n- h1: 44px\n- h2: 30px\n- h3: 20px\n- body: 16px\n- caption: 12px\n\n` +
        `## Shape\n\n- border-radius: 6px\n\n` +
        `## Applying it\n\nPlain and operational.\n`,
    )
  }

  for (const file of fontFiles) {
    writeFileSync(join(dir, 'fonts', file), 'not-a-real-font')
  }

  for (const asset of assets) {
    if (asset.write === false) continue
    writeFileSync(join(dir, asset.path), SQUARE_SVG('#FE7A11', asset.kind))
  }

  if (!omitManifest) {
    writeFileSync(
      join(dir, 'brand', 'asset_manifest.json'),
      JSON.stringify(
        {
          brand_kit_id: kitId,
          assets: assets.map((a) => ({
            kind: a.kind,
            path: a.path,
            brand_kit_id: a.kitId ?? kitId,
          })),
        },
        null,
        2,
      ),
    )
  }

  if (tokens) {
    writeFileSync(join(dir, 'brand', 'tokens.json'), JSON.stringify(tokens, null, 2))
  }

  return dir
}

describe('every brain in the packet ingests', () => {
  it.each(packetBrains)('$slug plans without being blocked', (brain) => {
    const plan = planIngest(brain.dir)
    expect(plan.ok).toBe(true)
    expect(isBlocked(plan)).toBe(false)
    expect(plan.kitId).toBe(brain.kitId)
    expect(plan.objects.length).toBeGreaterThan(4)
    expect(plan.fonts.length).toBeGreaterThan(0)
  })

  it.each(packetBrains)('$slug stores every file under its kit prefix', (brain) => {
    const plan = planIngest(brain.dir)
    for (const object of plan.objects) {
      expect(object.storageKey.startsWith(`${brain.kitId}/`)).toBe(true)
      expect(object.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(object.bytes).toBeGreaterThan(0)
    }
  })

  it('surfaces the packet hazards at ingest rather than at render time', () => {
    const codes = packetBrains.flatMap((b) => planIngest(b.dir).findings.map((f) => f.code))
    // These are the hazards actually planted in the packet. If any disappears,
    // a fixture is gone and the corresponding check would pass vacuously.
    expect(codes).toContain('asset-missing-file')
    expect(codes).toContain('asset-foreign-kit')
    expect(codes).toContain('font-substituted')
    expect(codes).toContain('token-cache-conflict')
  })

  it('withholds the token cache from runs while still storing it', () => {
    const plans = packetBrains.map((b) => planIngest(b.dir))
    const withheld = plans.filter((p) =>
      p.findings.some((f) => f.code === 'withheld-from-runs'),
    )
    expect(withheld.length).toBeGreaterThan(0)
    for (const plan of withheld) {
      expect(plan.objects.some((o) => o.storageKey.endsWith('brand/tokens.json'))).toBe(true)
    }
  })
})

describe('a foreign asset is quarantined, not offered', () => {
  it('excludes it from the assets a run may use', () => {
    const plan = planIngest(writeSyntheticBrain({
      kitId: 'bk-northwind-2031',
      assets: [
        { kind: 'logo', path: 'brand/northwind-logo.svg' },
        { kind: 'logo_lockup', path: 'brand/partner-lockup.svg', kitId: 'bk-someone-else-2031' },
      ],
    }))

    const foreign = plan.assets.find((a) => a.manifestPath.endsWith('partner-lockup.svg'))
    expect(foreign?.available).toBe(false)
    expect(foreign?.reason).toMatch(/belongs to bk-someone-else-2031/)

    // Stored, so the evidence survives; withheld, so it cannot reach a canvas.
    expect(foreign?.storageKey).toBeTruthy()
    expect(availableAssets(plan).map((a) => a.manifestPath)).not.toContain(
      'brand/partner-lockup.svg',
    )
  })

  it('reports it for review rather than swallowing it', () => {
    const plan = planIngest(writeSyntheticBrain({
      assets: [{ kind: 'logo_lockup', path: 'brand/partner-lockup.svg', kitId: 'bk-other-9999' }],
    }))
    const finding = reviewFindings(plan).find((f) => f.code === 'asset-foreign-kit')
    expect(finding).toBeDefined()
    expect(finding?.detail).toMatch(/quarantined/)
  })
})

describe('kit identity comes from the manifest, never the folder', () => {
  it('ingests under the manifest kit even when the folder disagrees', () => {
    const plan = planIngest(writeSyntheticBrain({
      kitId: 'bk-real-identity-2031',
      folderName: 'a-misleading-folder-name',
    }))
    expect(plan.kitId).toBe('bk-real-identity-2031')
    expect(plan.objects.every((o) => o.storageKey.startsWith('bk-real-identity-2031/'))).toBe(true)
    expect(plan.findings.some((f) => f.code === 'folder-name-differs-from-kit')).toBe(true)
  })
})

describe('a brand nobody has seen ingests with no code change', () => {
  it('plans a synthetic brain end to end', () => {
    const plan = planIngest(writeSyntheticBrain())
    expect(plan.ok).toBe(true)
    expect(isBlocked(plan)).toBe(false)
    expect(plan.kitId).toBe('bk-northwind-2031')
    expect(availableAssets(plan).length).toBe(1)
    expect(plan.fonts.map((f) => f.familySlug)).toEqual(['ashgrove', 'ashgrove'])
  })

  it('applies the generic font substitution to an invented family', () => {
    const plan = planIngest(writeSyntheticBrain({
      headingFamily: 'Ashgrove Condensed',
      fontFiles: ['ashgrove_400_normal.ttf', 'ashgrove_600_normal.ttf'],
    }))
    const family = plan.families.find((f) => f.declared === 'Ashgrove Condensed')
    expect(family?.substituted).toBe(true)
    expect(family?.resolvedFamilySlug).toBe('ashgrove')
    expect(family?.weight).toBe(600)
    expect(plan.findings.some((f) => f.code === 'font-substituted')).toBe(true)
  })

  it('reports an unresolvable family instead of allowing a fallback', () => {
    const plan = planIngest(writeSyntheticBrain({
      headingFamily: 'Totally Unrelated Face',
      fontFiles: ['ashgrove_400_normal.ttf'],
    }))
    expect(plan.findings.some((f) => f.code === 'font-unresolvable')).toBe(true)
  })

  it('reports a manifest entry with no file behind it', () => {
    const plan = planIngest(writeSyntheticBrain({
      assets: [
        { kind: 'logo', path: 'brand/northwind-logo.svg' },
        { kind: 'logo_reverse', path: 'brand/northwind-logo-white.svg', write: false },
      ],
    }))
    const missing = plan.assets.find((a) => a.manifestPath.endsWith('-white.svg'))
    expect(missing?.available).toBe(false)
    expect(missing?.storageKey).toBeNull()
    expect(plan.findings.some((f) => f.code === 'asset-missing-file')).toBe(true)
  })
})

describe('the token cache never wins', () => {
  it('flags a palette disagreement and keeps the document authoritative', () => {
    const plan = planIngest(writeSyntheticBrain({
      tokens: { palette: { accent: '#00FF00' }, type_scale: { h1: '99px' }, radii: ['32px'] },
    }))
    const conflicts = plan.findings.filter((f) => f.code === 'token-cache-conflict')
    expect(conflicts.length).toBe(3)
    expect(conflicts.map((c) => c.detail).join(' ')).toMatch(/DESIGN\.md wins/)
  })

  it('survives an unreadable cache, because the cache has no authority', () => {
    const dir = writeSyntheticBrain()
    writeFileSync(join(dir, 'brand', 'tokens.json'), '{ not json')
    const plan = planIngest(dir)
    expect(plan.ok).toBe(true)
    expect(plan.findings.some((f) => f.code === 'token-cache-unreadable')).toBe(true)
  })
})

describe('a brain that cannot be trusted is blocked, with a reason', () => {
  it('blocks a directory with no DESIGN.md', () => {
    const plan = planIngest(writeSyntheticBrain({ omitDesignDoc: true }))
    expect(isBlocked(plan)).toBe(true)
    expect(plan.findings[0].code).toBe('no-design-doc')
  })

  it('blocks a directory with no asset manifest, since the kit has no identity', () => {
    const plan = planIngest(writeSyntheticBrain({ omitManifest: true }))
    expect(isBlocked(plan)).toBe(true)
    expect(plan.findings[0].code).toBe('no-asset-manifest')
  })

  it('blocks a manifest with no kit id', () => {
    const dir = writeSyntheticBrain()
    writeFileSync(
      join(dir, 'brand', 'asset_manifest.json'),
      JSON.stringify({ assets: [] }),
    )
    const plan = planIngest(dir)
    expect(isBlocked(plan)).toBe(true)
    expect(plan.findings[0].code).toBe('no-kit-id')
  })

  it('blocks a path that is not a directory at all', () => {
    expect(isBlocked(planIngest(join(tmpdir(), 'does-not-exist-cq')))).toBe(true)
  })
})

describe('adding assets to a kit that already exists', () => {
  it('re-planning after a new asset lands includes it and keeps the same kit', () => {
    const dir = writeSyntheticBrain({ kitId: 'bk-northwind-2031' })
    const before: IngestPlan = planIngest(dir)

    writeFileSync(join(dir, 'brand', 'northwind-mark.svg'), SQUARE_SVG('#123456', 'mark'))
    writeFileSync(
      join(dir, 'brand', 'asset_manifest.json'),
      JSON.stringify({
        brand_kit_id: 'bk-northwind-2031',
        assets: [
          { kind: 'logo', path: 'brand/northwind-logo.svg', brand_kit_id: 'bk-northwind-2031' },
          { kind: 'logo_mark', path: 'brand/northwind-mark.svg', brand_kit_id: 'bk-northwind-2031' },
        ],
      }),
    )

    const after = planIngest(dir)
    expect(after.kitId).toBe(before.kitId)
    expect(availableAssets(after).length).toBe(availableAssets(before).length + 1)
    expect(after.objects.length).toBeGreaterThan(before.objects.length)
  })

  it('changes an object digest when its bytes change, so a revision is traceable', () => {
    const dir = writeSyntheticBrain()
    const first = planIngest(dir)
    const key = `${first.kitId}/brand/northwind-logo.svg`
    const before = first.objects.find((o) => o.storageKey === key)?.sha256

    writeFileSync(join(dir, 'brand', 'northwind-logo.svg'), SQUARE_SVG('#101418', 'logo v2'))
    const after = planIngest(dir).objects.find((o) => o.storageKey === key)?.sha256

    expect(before).toBeTruthy()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
  })
})

describe('ingest is deterministic', () => {
  it('produces the same plan twice for the same input', () => {
    const brain = packetBrains[0]
    const a = planIngest(brain.dir)
    const b = planIngest(brain.dir)
    expect(b.objects).toEqual(a.objects)
    expect(b.assets).toEqual(a.assets)
    expect(b.findings).toEqual(a.findings)
  })

  it('copies of the same brain plan identically apart from the source path', () => {
    const brain = packetBrains[0]
    const copyRoot = tempDir('cq-copy-')
    const copy = join(copyRoot, brain.slug)
    cpSync(brain.dir, copy, { recursive: true })

    const original = planIngest(brain.dir)
    const duplicate = planIngest(copy)
    expect(duplicate.kitId).toBe(original.kitId)
    expect(duplicate.objects.map((o) => o.storageKey)).toEqual(
      original.objects.map((o) => o.storageKey),
    )
    expect(duplicate.objects.map((o) => o.sha256)).toEqual(
      original.objects.map((o) => o.sha256),
    )
  })
})
