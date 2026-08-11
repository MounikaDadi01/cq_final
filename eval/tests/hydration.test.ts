import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildDeploymentHydration,
  buildGenerationHydration,
  hydrationGaps,
  hydrationLeaks,
  RUN_BUDGET_SECONDS,
  type GenerationInput,
} from '../src/hydration'

/**
 * What goes into a box, and what must never.
 *
 * The fixtures use invented kits. A test that used the packet's real brands could
 * pass while the builder quietly special-cased them, which is the exact failure
 * these assertions exist to catch.
 */

const ROOT = join(import.meta.dirname, '..', '..')

const input: GenerationInput = {
  runId: 'run-1',
  revisionId: 'rev-1',
  brandKitId: 'bk-invented-2026',
  task: 'new',
  campaignName: 'A campaign',
  copy: { headline: 'A headline', cta: 'Do the thing', legal: null },
  plateDirection: 'A flat field with the upper half empty.',
  inspirations: ['some-reference.png'],
  canvases: [
    { name: 'square', width: 1080, height: 1080, producible: true },
    {
      name: 'leaderboard',
      width: 728,
      height: 90,
      producible: false,
      refusal: 'aspect 8.09:1 exceeds the 3:1 ceiling',
    },
  ],
  kitFiles: [
    { path: 'DESIGN.md', storageKey: 'k/DESIGN.md', purpose: 'the brand', digest: 'a'.repeat(64) },
    { path: 'brand/asset_manifest.json', storageKey: 'k/brand/asset_manifest.json', purpose: 'staged assets' },
    { path: 'brand/a-logo.svg', storageKey: 'k/brand/a-logo.svg', purpose: 'logo' },
    { path: 'fonts/face_400_normal.ttf', storageKey: 'k/fonts/face_400_normal.ttf', purpose: 'body' },
    { path: 'fonts/face_700_normal.ttf', storageKey: 'k/fonts/face_700_normal.ttf', purpose: 'heading' },
  ],
  inspirationKeys: [{ path: 'some-reference.png', storageKey: 'insp/some-reference.png' }],
  resolved: {
    palette: { primary: '#102030', surface: '#FFFFFF', ink: '#101010' },
    type_scale: { h1: '48px' },
    heading_family: 'face',
    body_family: 'face',
    heading_substituted: true,
    heading_note: 'no file for "Face Condensed"; nearest shipped family "face" at weight 700',
    contested: ['h1: table said 56px, prose said 48px; prose governs'],
    ground_switch_point: { value: 0.188, source: 'logo_reverse note names #6B7A88' },
  },
  knownFindings: [
    { code: 'asset-missing-file', severity: 'review', detail: 'logo_reverse has no file behind it' },
  ],
  conversation: [{ role: 'user', body: 'Make it feel calmer.', at: '2026-08-10T10:00:00Z' }],
}

describe('generation hydration', () => {
  const h = buildGenerationHydration(input)

  it('mounts the skill as a skill the agent invokes', () => {
    expect(h.skill.invoke).toBe('design-generation')
    // The path matters: this is where a skill is discovered, so the agent can
    // invoke the contract rather than be told a paraphrase of it.
    expect(h.skill.mount.path).toMatch(/\.claude\/skills\/design-generation\/SKILL\.md$/)
  })

  it('names the skill exactly as the repo skill is named', () => {
    // If these drift, the hydration file mounts a skill by a name that does not
    // exist in the box, and the agent silently proceeds without the contract.
    const installed = readFileSync(join(ROOT, '.claude/skills/design-generation/SKILL.md'), 'utf8')
    const declared = /^name:\s*(\S+)/m.exec(installed)?.[1]
    expect(declared).toBe(h.skill.invoke)
  })

  it('bakes the skill rather than fetching it per run', () => {
    // Identical for every customer and every run, so a per-run fetch would add a
    // failure mode for no benefit.
    expect(h.skill.mount.lifetime).toBe('baked')
    expect(h.skill.mount.storageKey).toBeNull()
  })

  it('pulls brand files fresh per customer, with a stated purpose each', () => {
    const kit = h.mounts.filter((m) => m.lifetime === 'kit')
    expect(kit.length).toBe(5)
    for (const m of kit) {
      expect(m.storageKey).toBeTruthy()
      // A mount with no stated purpose cannot be reviewed, only trusted.
      expect(m.purpose.length).toBeGreaterThan(0)
    }
  })

  it('mounts the fonts and the assets, not just the documents', () => {
    const paths = h.mounts.map((m) => m.path)
    // The failure this catches is the quiet one: a render with no font files
    // still produces an ad, in a browser fallback face, off-brand and plausible.
    expect(paths.filter((p) => p.includes('/brain/fonts/')).length).toBe(2)
    expect(paths.some((p) => p.endsWith('.svg'))).toBe(true)
  })

  it('mounts every attached inspiration and nothing else', () => {
    const mounted = h.mounts.filter((m) => m.path.includes('/inspirations/'))
    expect(mounted).toHaveLength(h.campaign.inspirations.length)
    expect(mounted[0].purpose).toMatch(/composition reference only/)
  })

  it('mounts itself, so the box can re-read its own instructions', () => {
    expect(h.mounts.some((m) => m.path.endsWith('hydration.json'))).toBe(true)
  })

  it('carries settled brand resolution so the run does not re-derive it', () => {
    expect(h.context.resolved.heading_substituted).toBe(true)
    expect(h.context.resolved.heading_note).toContain('nearest shipped family')
    // A contested value re-litigated per run could resolve differently each time,
    // which a customer reads as the system changing its mind.
    expect(h.context.resolved.contested.length).toBeGreaterThan(0)
    expect(h.context.resolved.ground_switch_point?.source).toContain('note names')
  })

  it('carries the conversation and the known findings', () => {
    expect(h.context.conversation[0].body).toBe('Make it feel calmer.')
    expect(h.context.known_findings[0].code).toBe('asset-missing-file')
  })

  it('withholds the token cache, and says why', () => {
    const tokens = h.withheld.find((w) => w.path.includes('tokens.json'))
    expect(tokens).toBeTruthy()
    // Newer than DESIGN.md and disagreeing with it, so anything resolving by
    // recency picks wrong. Not being there is the cheapest way to not consult it.
    expect(tokens?.reason).toMatch(/no authority|newer/)
  })

  it('states the tree it expects to produce', () => {
    // So a half-finished run is recognisable as half-finished, rather than looking
    // like a complete run that happened to make less.
    expect(h.outputs.expected_tree).toContain('renders/square.png')
    expect(h.outputs.expected_tree).toContain('RESULT.json')
    // The refused canvas must not appear as something to produce.
    expect(h.outputs.expected_tree.join(' ')).not.toContain('leaderboard')
  })

  it('caps image calls so a loop cannot spend without bound', () => {
    expect(h.limits.max_image_calls).toBe(2)
  })

  it('reports no gaps for a complete file', () => {
    expect(hydrationGaps(h)).toEqual([])
  })

  it('reports a missing font mount rather than letting a render fall back', () => {
    const noFonts = buildGenerationHydration({
      ...input,
      kitFiles: input.kitFiles.filter((f) => !f.path.startsWith('fonts/')),
    })
    expect(hydrationGaps(noFonts).join(' ')).toMatch(/no font files/)
  })

  it('reports an attached inspiration that was not mounted', () => {
    const unmounted = buildGenerationHydration({ ...input, inspirationKeys: [] })
    expect(hydrationGaps(unmounted).join(' ')).toMatch(/1 inspirations attached but 0 mounted/)
  })

  it('reports an edit with no parent and no instruction', () => {
    const edit = buildGenerationHydration({ ...input, task: 'edit' })
    const gaps = hydrationGaps(edit).join(' ')
    expect(gaps).toMatch(/no parent revision/)
    expect(gaps).toMatch(/no instruction/)
  })

  it('reports a run where nothing is producible', () => {
    const nothing = buildGenerationHydration({
      ...input,
      canvases: [{ name: 'leaderboard', width: 728, height: 90, producible: false }],
    })
    expect(hydrationGaps(nothing).join(' ')).toMatch(/nothing it could make/)
  })

  it('states the resolution order rather than leaving it to the code', () => {
    expect(h.resolution_order.length).toBeGreaterThanOrEqual(5)
    const joined = h.resolution_order.join(' | ')
    // DESIGN.md must be described as outranking the hydration file itself, or the
    // box has no way to know a request cannot override the brand.
    expect(joined).toMatch(/DESIGN\.md.*[Ww]ins over/)
    // The skill has to be read before the brand files it governs the use of.
    const skillAt = h.resolution_order.findIndex((l) => l.includes('design-generation'))
    const designAt = h.resolution_order.findIndex((l) => l.startsWith('DESIGN.md'))
    expect(skillAt).toBeGreaterThanOrEqual(0)
    expect(skillAt).toBeLessThan(designAt)
  })

  it('carries an unproducible canvas as a refusal rather than dropping it', () => {
    const leaderboard = h.canvases.find((c) => c.name === 'leaderboard')
    // Dropping it would make "we did not make it" and "you did not ask" identical
    // in the output.
    expect(leaderboard?.producible).toBe(false)
    expect(leaderboard?.refusal).toContain('3:1')
  })

  it('tells the agent to save its own work, and how often', () => {
    expect(h.outputs.save_with).toBe('save_work')
    expect(h.outputs.checkpoint_every_seconds).toBeGreaterThan(0)
    expect(h.outputs.checkpoint_every_seconds).toBeLessThan(h.limits.sandbox_timeout_seconds)
  })

  it('shares one budget across token, URLs and timeout', () => {
    expect(h.limits.sandbox_timeout_seconds).toBe(RUN_BUDGET_SECONDS)
  })

  it('declares egress so an unexpected destination is visible', () => {
    expect(h.egress.join(' ')).toContain('api.openai.com')
  })

  it('carries the edit instruction only on an edit', () => {
    expect(h.edit_instruction).toBeNull()
    const edit = buildGenerationHydration({
      ...input,
      task: 'edit',
      parentRevisionId: 'rev-0',
      editInstruction: 'Make the headline shorter.',
    })
    expect(edit.task).toBe('edit')
    expect(edit.parent_revision_id).toBe('rev-0')
    expect(edit.edit_instruction).toBe('Make the headline shorter.')
  })

  it('contains no brand name anywhere in its structure', () => {
    // The packet's real brands, checked against a file built for an invented one.
    const leaks = hydrationLeaks(h, {
      secrets: [],
      brandNames: ['kahua', 'emplifi', 'barlow', 'inter'],
    })
    expect(leaks).toEqual([])
  })

  it('refuses to hide a leaked secret', () => {
    const secret = 'sk-svcacct-abcdefghijklmnop'
    const poisoned = buildGenerationHydration({
      ...input,
      plateDirection: `A field. ${secret}`,
    })
    const leaks = hydrationLeaks(poisoned, { secrets: [secret], brandNames: [] })
    expect(leaks).toHaveLength(1)
    expect(leaks[0]).toContain('secret value appears')
  })

  it('ignores a short "secret" that would match by coincidence', () => {
    // A two-character secret would flag every file and the check would be ignored.
    const leaks = hydrationLeaks(h, { secrets: ['ab'], brandNames: [] })
    expect(leaks).toEqual([])
  })
})

describe('deployment hydration', () => {
  const d = buildDeploymentHydration({
    runId: 'run-2',
    revisionId: 'rev-1',
    brandKitId: 'bk-invented-2026',
    publish: [
      {
        canvas: 'square',
        relative_path: 'renders/square.png',
        signed_url: 'https://example.supabase.co/storage/v1/object/sign/work/x?token=y',
        bytes: 1_397_480,
        width: 1080,
        height: 1080,
      },
    ],
    target: {
      tool: 'adstream',
      entry_url: 'https://app.example-adtool.com/campaigns/new',
      credential_env: ['DEPLOY_USERNAME', 'DEPLOY_PASSWORD'],
    },
    campaignName: 'A campaign',
    copy: { headline: 'A headline', cta: 'Do the thing' },
  })

  it('says exactly what to publish rather than letting the box decide', () => {
    // A box that had to work out what "finished" means could publish a
    // half-saved revision.
    expect(d.publish).toHaveLength(1)
    expect(d.publish[0].relative_path).toBe('renders/square.png')
    expect(d.publish[0].signed_url).toContain('token=')
  })

  it('names credentials by environment variable, never carrying their values', () => {
    expect(d.target.credential_env).toEqual(['DEPLOY_USERNAME', 'DEPLOY_PASSWORD'])
    const serialised = JSON.stringify(d)
    // The file is saved beside the run for audit, so a secret written into it
    // would be readable for as long as the record exists.
    expect(serialised).not.toMatch(/password"\s*:\s*"[^"]+"/i)
  })

  it('writes only into the reserved deploy subdirectory', () => {
    expect(d.outputs.root).toMatch(/\/work\/deploy$/)
  })

  it('requires a recording', () => {
    // Playwright flushes video on context close, so a killed box loses it. No
    // recording means no evidence a deploy happened.
    expect(d.outputs.recording_required).toBe(true)
  })

  it('declares the tool host as egress', () => {
    expect(d.egress.join(' ')).toContain('app.example-adtool.com')
  })

  it('mounts a deploy skill distinct from the generation skill', () => {
    expect(d.skill.invoke).toBe('deploy-campaign')
    expect(d.skill.mount.path).not.toContain('design-generation')
  })

  it('does not regenerate anything', () => {
    // Stated in the resolution order so the box is told, not merely prevented.
    expect(d.resolution_order.join(' ')).toMatch(/nothing is regenerated/i)
  })

  it('contains no brand name in its structure', () => {
    expect(hydrationLeaks(d, { secrets: [], brandNames: ['kahua', 'emplifi'] })).toEqual([])
  })
})
