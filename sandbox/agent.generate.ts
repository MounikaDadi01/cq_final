/**
 * The generation agent. Runs inside the box, and is the only thing that does.
 *
 * The division of labour is the whole design:
 *
 *   arithmetic is code   — legal canvas sizes, resampling, font provenance,
 *                          contrast, palette conformance, logo aspect. All of it
 *                          already covered by the repo's test suite, staged in as
 *                          `toolkit/` rather than re-described in a prompt.
 *
 *   judgement is the model — what the plate should depict, where the copy sits,
 *                          which typographic scale suits which canvas, whether the
 *                          result is actually any good.
 *
 * A tool that returned only "ok: true" would waste the second half. So every tool
 * hands back measurements *and* the rendered image, because `AdGeneration.md` is
 * explicit that the model can read images and should look at what it made before
 * anything calls itself done. That review step is the one thing a deterministic
 * check cannot do: it catches a wordmark sitting on a laptop, or a composition that
 * simply does not look like the brand.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Agent, run, tool } from '@openai/agents'
import OpenAI from 'openai'
import { z } from 'zod'

import { GPT_IMAGE_2, planGeneration } from './toolkit/capability'
import { loadBrain, resolveFamily, resolveScaleValue, type Brain } from './toolkit/brain'
import { generatePlate, PlateImpossible, classifyImageFailure } from './toolkit/plate'
import { createOpenAIImageCaller } from './toolkit/openai-image'
import { buildOverlay, type CampaignStyle } from './toolkit/overlay'
import { decodePng, encodePng } from './toolkit/png'
import { resampleTo } from './toolkit/resample'
import { launchBrowser, renderCanvas, verifyFonts } from './toolkit/render'
import { failures, runAllChecks, unverified, type ArtifactBundle } from './toolkit/checks'

const HOME = process.env.HOME ?? '/home/user'
const WORK = process.env.CQ_WORK_DIR ?? join(HOME, 'work')
const MODEL = process.env.CQ_AGENT_MODEL ?? 'gpt-5.6-sol'

interface Hydration {
  kind: 'generate'
  run_id: string
  revision_id: string
  brand_kit_id: string
  task: 'new' | 'edit'
  edit_instruction: string | null
  campaign: {
    name: string
    copy: Record<string, string | null>
    plate_direction: string | null
    inspirations: string[]
  }
  canvases: { name: string; width: number; height: number; producible: boolean; refusal?: string }[]
  skill: { invoke: string; mount: { path: string } }
  resolution_order: string[]
  context: {
    conversation: { role: string; body: string; at: string }[]
    resolved: Record<string, unknown>
    known_findings: { code: string; severity: string; detail: string }[]
    parent: unknown
  }
  withheld: { path: string; reason: string }[]
  outputs: { root: string; save_with: string; checkpoint_every_seconds: number; expected_tree: string[] }
  limits: { sandbox_timeout_seconds: number; image_quality: 'low' | 'medium' | 'high'; max_image_calls: number }
}

const hydration: Hydration = JSON.parse(readFileSync(join(HOME, 'hydration.json'), 'utf8'))

/**
 * The box pulls its own brand files, with its own token.
 *
 * The launcher could have pushed them in, and that would be easier. It would also
 * mean the run never exercises the policy that is supposed to protect the tenant —
 * a leak would sit undetected because nothing ever asked the database for anything.
 * Fetching here makes every run a live test of its own isolation: if the token is
 * wrong or the policy is wrong, hydration fails loudly instead of quietly working.
 *
 * Digests are verified where the manifest states one, so a truncated download is a
 * failure rather than a brand rendered from half a file.
 */
async function pullMounts(): Promise<void> {
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  const token = process.env.CQ_RUN_TOKEN
  if (!url || !anon || !token) throw new Error('hydration needs SUPABASE_URL, SUPABASE_ANON_KEY, CQ_RUN_TOKEN')

  const pulled: string[] = []
  for (const mount of (hydration as unknown as { mounts: { path: string; storageKey: string | null; digest?: string }[] }).mounts) {
    if (!mount.storageKey) continue
    const response = await fetch(`${url}/storage/v1/object/brains/${mount.storageKey}`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      throw new Error(`could not pull ${mount.storageKey}: ${response.status} ${await response.text()}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (mount.digest) {
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== mount.digest) {
        throw new Error(`${mount.storageKey} digest mismatch: expected ${mount.digest}, got ${actual}`)
      }
    }
    mkdirSync(dirname(mount.path), { recursive: true })
    writeFileSync(mount.path, bytes)
    pulled.push(mount.path.replace(HOME + '/', ''))
  }
  console.log(`hydrated ${pulled.length} file(s): ${pulled.slice(0, 6).join(', ')}${pulled.length > 6 ? ' …' : ''}`)
}

await pullMounts()

const brain: Brain = loadBrain(join(HOME, 'brain'))
const skillBody = readFileSync(hydration.skill.mount.path, 'utf8')

const imageCall = createOpenAIImageCaller({
  apiKey: process.env.OPENAI_API_KEY ?? '',
  model: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
  timeoutMs: 300_000,
})

const browser = await launchBrowser()

/** Spent against `limits.max_image_calls`, so a loop cannot bill without bound. */
let imageCalls = 0
/** Running total for the visual review, reported at the end of the run. */
let reviewTokens = 0
const findings: { code: string; severity: string; detail: string }[] = []
const record: Record<string, unknown>[] = []

const canvasByName = (name: string) => hydration.canvases.find((c) => c.name === name)

const relative = (absolute: string) => absolute.slice(WORK.length + 1)

/**
 * Looks at a rendered ad and says what is wrong with it.
 *
 * This is the review step `AdGeneration.md` asks for — "the model can read images,
 * have it look at what it made" — and it is a separate call for a reason that cost
 * a live run to learn. Returning a data URL from a tool puts base64 into the *text*
 * channel: the first attempt requested 339,445 tokens for one turn and hit a rate
 * limit, and the model would not have seen an image anyway, just a wall of
 * characters. An image has to arrive as an image content part.
 *
 * Downscaled first, because the judgements being asked — does the headline read,
 * does the logo survive its ground, does this look like the brand — do not need
 * 1080px. Everything measurable already came from the checks at full resolution.
 */
const PREVIEW_MAX_EDGE = 768

function previewDataUrl(path: string): string {
  const raster = decodePng(readFileSync(path))
  const scale = PREVIEW_MAX_EDGE / Math.max(raster.width, raster.height)
  const preview =
    scale >= 1
      ? raster
      : resampleTo(raster, Math.round(raster.width * scale), Math.round(raster.height * scale))
  return `data:image/png;base64,${encodePng(preview).toString('base64')}`
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })

async function reviewRender(path: string, canvas: string): Promise<string> {
  try {
    const response = await openai.responses.create({
      model: MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                `This is a finished ${canvas} ad for the brand described below.`,
                'Judge it as a design director would, in six lines or fewer.',
                'Answer only these: can the headline be read instantly; does the logo',
                'survive the ground behind it; is any element colliding with or sitting',
                'on top of something it should not; is there any typography, wordmark or',
                'UI text visible inside the photograph itself; does it look like this',
                'brand. Say what to change, concretely. If it is good, say so plainly.',
                '',
                `palette: ${JSON.stringify(brain.palette)}`,
                `brand voice and rules, abbreviated: ${brain.designDoc.slice(0, 1200)}`,
              ].join('\n'),
            },
            { type: 'input_image', image_url: previewDataUrl(path), detail: 'high' },
          ],
        },
      ],
    })
    // Logged because this call is the one that blew the context window when the
    // image went through the text channel. A number here means the next surprise is
    // measurable rather than inferred from a rate-limit message.
    const usage = response.usage
    if (usage) {
      console.log(
        `[review] ${canvas}: ${usage.input_tokens} in (${usage.input_tokens_details?.cached_tokens ?? 0} cached), ` +
          `${usage.output_tokens} out, ${usage.total_tokens} total`,
      )
      reviewTokens += usage.total_tokens ?? 0
    }
    return response.output_text?.trim() || '(the reviewer returned nothing)'
  } catch (error) {
    // A failed review must not fail the run. It is reported as unavailable so the
    // difference between "reviewed and fine" and "never reviewed" stays visible.
    return `(review unavailable: ${(error as Error).message.slice(0, 160)})`
  }
}

const plateTool = tool({
  name: 'generate_plate',
  description:
    'Generate the background plate for one canvas. Text-free by construction. ' +
    'Returns the legal size used and any distortion. Call render_canvas next to see it.',
  parameters: z.object({
    canvas: z.string().describe('canvas name from hydration.canvases'),
    direction: z
      .string()
      .describe(
        'The photo brief: composition, subject, lighting, texture, and exactly where ' +
          'to leave empty space for copy. Palette and prohibitions are appended for you.',
      ),
  }),
  async execute({ canvas, direction }) {
    console.log(`[tool] generate_plate canvas=${JSON.stringify(canvas)}`)
    const spec = canvasByName(canvas)
    if (!spec) {
      // Name the alternatives. A bare "not found" makes the model guess again;
      // telling it what exists lets it correct itself in one turn.
      return {
        error: `no canvas named ${JSON.stringify(canvas)}`,
        available: hydration.canvases.map((c) => c.name),
      }
    }
    if (!spec.producible) return { error: `${canvas} is not producible: ${spec.refusal}` }
    if (imageCalls >= hydration.limits.max_image_calls) {
      return { error: `image call budget spent (${hydration.limits.max_image_calls})` }
    }

    const palette = Object.entries(brain.palette)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
    const prompt = [
      direction,
      `Aspect ratio exactly ${spec.width}:${spec.height}, filling the frame edge to edge.`,
      `Brand palette to work within: ${palette}.`,
      'This is a background plate only. It must contain absolutely no words, letters,',
      'numbers, captions, logos, wordmarks, badges, buttons, button labels, UI text,',
      'watermarks, signatures or any typography of any kind. Leave the described',
      'negative space genuinely empty.',
    ].join(' ')

    const references = hydration.campaign.inspirations
      .map((name) => join(HOME, 'inspirations', name))
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p))

    try {
      const plate = await generatePlate(
        {
          targetWidth: spec.width,
          targetHeight: spec.height,
          prompt,
          quality: hydration.limits.image_quality,
          referenceImages: references,
        },
        imageCall,
      )
      imageCalls++

      const dir = join(WORK, `html_${canvas}`, 'assets')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'plate.png')
      writeFileSync(path, encodePng(plate.raster))

      return {
        canvas,
        saved: relative(path),
        target: `${spec.width}x${spec.height}`,
        generated: `${plate.generatedWidth}x${plate.generatedHeight}`,
        anisotropy_pct: Number((plate.anisotropy * 100).toFixed(4)),
        image_calls_remaining: hydration.limits.max_image_calls - imageCalls,
      }
    } catch (error) {
      if (error instanceof PlateImpossible) return { error: error.message, kind: 'impossible' }
      const classified = classifyImageFailure(error)
      // The classification matters to the model: `retry` is worth another attempt,
      // `change-the-request` means rewording, `needs-human` means stop.
      return { error: classified.hint, kind: classified.kind }
    }
  },
})

/**
 * The style the overlay builder actually accepts, as a schema rather than prose.
 *
 * The first live run described this as "JSON matching the campaign style shape" and
 * the model — reasonably — invented its own: pixel rectangles for `copyArea`, a
 * nested object for `ground`. It could not have guessed the real shape, and every
 * render failed on palette validation.
 *
 * Colours are palette NAMES, never hex, so a colour that is not in the kit cannot
 * be expressed. That is the point: the type refuses off-brand colour rather than a
 * check catching it afterwards.
 */
const TEXT_STYLE = z.object({
  colour: z.string().describe('a palette key from DESIGN.md, e.g. ink, surface, accent'),
  size: z.string().describe('CSS length, e.g. "48px", taken from the brand type scale'),
  weight: z.number().describe('400, 500, 600 or 700 — falls back to the nearest shipped weight'),
  tracking: z.string().nullable().describe('letter-spacing, e.g. "0.12em", or null'),
  leading: z.string().nullable().describe('line-height multiple, e.g. "1.05", or null'),
  uppercase: z.boolean().nullable(),
})

const STYLE_SCHEMA = z.object({
  ground: z.enum(['dark', 'light']).describe('a hint only — the plate is measured and may override it'),
  /**
   * Where the logo goes. Null means "pick a free corner".
   *
   * Set it whenever a comment says where the logo should be, and it goes there. Corner
   * choice is a layout preference, not a safety mechanism — the thing that keeps the
   * right logo on the right ground is the variant choice, made from the ad's overall
   * brightness, and that is unaffected by this.
   */
  logoCorner: z
    .enum(['top-left', 'top-right', 'bottom-left', 'bottom-right'])
    .nullable()
    .describe('where the logo sits; null to let a free corner be chosen'),
  copyArea: z.enum(['upper', 'lower', 'left']).describe('where the copy block sits; must match the empty space the plate has'),
  eyebrow: TEXT_STYLE,
  headline: TEXT_STYLE,
  subhead: TEXT_STYLE,
  cta: z.object({
    fill: z.string().describe('palette key, or "none" for an outline-only button'),
    label: z.string().describe('palette key for the label text'),
    border: z.string().nullable().describe('palette key for a 2px outline, or null'),
    size: z.string(),
    weight: z.number(),
    radius: z.string().describe('e.g. "4px" or "999px" for a pill — from the brand shape rules'),
  }),
})

/** Palette keys the kit publishes, so a bad colour names its alternatives. */
const paletteKeys = Object.keys(brain.palette)

function badColours(style: z.infer<typeof STYLE_SCHEMA>): string[] {
  const named = [
    style.eyebrow.colour,
    style.headline.colour,
    style.subhead.colour,
    style.cta.fill,
    style.cta.label,
    style.cta.border,
  ].filter((c): c is string => Boolean(c) && c !== 'none')
  return named.filter((c) => !paletteKeys.includes(c))
}

const renderTool = tool({
  name: 'render_canvas',
  description:
    'Lay the copy over an existing plate as live HTML, render it in a real browser, ' +
    'run every deterministic check, and return the measurements plus a visual review ' +
    'from a model that looked at the result. Call after generate_plate. Safe to call ' +
    'repeatedly — it reuses the plate, so only the review costs anything.',
  parameters: z.object({
    canvas: z.string(),
    style: STYLE_SCHEMA,
  }),
  async execute({ canvas, style }) {
    console.log(`[tool] render_canvas canvas=${JSON.stringify(canvas)} copyArea=${style.copyArea}`)
    const spec = canvasByName(canvas)
    if (!spec) {
      return { error: `no canvas named ${JSON.stringify(canvas)}`, available: hydration.canvases.map((c) => c.name) }
    }
    const platePath = join(WORK, `html_${canvas}`, 'assets', 'plate.png')
    if (!existsSync(platePath)) return { error: `no plate for ${canvas} — call generate_plate first` }

    const unknown = badColours(style)
    if (unknown.length) {
      return { error: `not palette keys: ${unknown.join(', ')}`, palette_keys: paletteKeys }
    }

    const heading = resolveFamily(brain, brain.type.heading ?? '')
    const body = resolveFamily(brain, brain.type.body ?? '')
    const plateRaster = decodePng(readFileSync(platePath))

    // The overlay builder expects `role` on each text style and drops nulls.
    const clean = (t: z.infer<typeof TEXT_STYLE>, role: string) => ({
      role,
      colour: t.colour,
      size: t.size,
      weight: t.weight,
      ...(t.tracking ? { tracking: t.tracking } : {}),
      ...(t.leading ? { leading: t.leading } : {}),
      ...(t.uppercase ? { uppercase: true } : {}),
    })
    const parsed = {
      ground: style.ground,
      copyArea: style.copyArea,
      eyebrow: clean(style.eyebrow, 'eyebrow'),
      headline: clean(style.headline, 'headline'),
      subhead: clean(style.subhead, 'subhead'),
      cta: {
        fill: style.cta.fill,
        label: style.cta.label,
        ...(style.cta.border ? { border: style.cta.border } : {}),
        size: style.cta.size,
        weight: style.cta.weight,
        radius: style.cta.radius,
      },
    } as unknown as CampaignStyle

    const overlay = buildOverlay({
      brain,
      campaign: {
        id: hydration.revision_id,
        brandKitId: hydration.brand_kit_id,
        copy: hydration.campaign.copy as never,
        inspirations: hydration.campaign.inspirations,
      } as never,
      canvas: spec as never,
      style: parsed,
      platePath: 'assets/plate.png',
      headingSlug: heading.resolvedFamilySlug ?? body.resolvedFamilySlug ?? '',
      bodySlug: body.resolvedFamilySlug ?? '',
      plateRaster,
      forceLogoCorner: style.logoCorner ?? undefined,
    })

    const htmlDir = join(WORK, `html_${canvas}`)
    if (overlay.logoPath && existsSync(overlay.logoPath)) {
      writeFileSync(join(htmlDir, basename(overlay.logoPath)), readFileSync(overlay.logoPath))
    }
    const htmlPath = join(htmlDir, 'index.html')
    writeFileSync(htmlPath, overlay.html)

    const render = await renderCanvas({
      htmlPath,
      width: spec.width,
      height: spec.height,
      expectedFaces: overlay.expectedFaces,
      browser,
    })
    mkdirSync(join(WORK, 'renders'), { recursive: true })
    const renderPath = join(WORK, 'renders', `${canvas}.png`)
    writeFileSync(renderPath, render.png)

    const fonts = verifyFonts(render)
    const bundle: ArtifactBundle = {
      canvas: spec as never,
      plate: { width: spec.width, height: spec.height, generatedWidth: spec.width, generatedHeight: spec.height },
      brandKitId: hydration.brand_kit_id,
      requiredStrings: [hydration.campaign.copy.headline, hydration.campaign.copy.cta].filter(Boolean) as string[],
      overlay: render.elements.map((el) => ({
        role: el.role,
        box: el.box,
        text: el.text,
        fontFamily: el.familySlug,
        declaredColours: el.colours,
        assetPath: el.src ? brain.assets.find((a) => a.path.endsWith(el.src as string))?.path : undefined,
        renderedWidth: el.role === 'logo' ? el.box.width : undefined,
        renderedHeight: el.role === 'logo' ? el.box.height : undefined,
      })),
    }
    const checks = runAllChecks(bundle, brain, render.raster)

    record.push({ canvas, fonts_ok: fonts.ok, failures: failures(checks).length })

    return {
      canvas,
      saved: relative(renderPath),
      fonts_ok: fonts.ok,
      font_problems: fonts.problems,
      logo: overlay.logoPath ? basename(overlay.logoPath) : null,
      logo_reason: overlay.logoNote,
      logo_ground: overlay.logoGround,
      // Reported so the agent can pass on what the ground measures there. Informational
      // only — the corner asked for is the corner used.
      logo_placed_as_asked: overlay.logoGround.forced,
      logo_ground_note: overlay.logoGround.forcedNote,
      copy_ground: overlay.copyGround,
      check_failures: failures(checks).map((f) => `${f.check}: ${f.detail}`),
      check_unverifiable: unverified(checks).map((f) => `${f.check}: ${f.detail}`),
      measured: render.elements.map((e) => ({ role: e.role, line: e.line, box: e.box })),
      review: await reviewRender(renderPath, canvas),
    }
  },
})

const findingTool = tool({
  name: 'report_finding',
  description:
    'Record something a person should know that did not stop the run — a substitution, ' +
    'a missing asset, a canvas you could not produce, a judgement you were unsure of.',
  parameters: z.object({
    code: z.string(),
    severity: z.enum(['blocker', 'review', 'info']),
    detail: z.string(),
  }),
  async execute({ code, severity, detail }) {
    findings.push({ code, severity, detail })

    // Also written to the database, not only to RESULT.json.
    //
    // The first live runs recorded findings in the result file alone, so the UI had
    // nothing to show — a substitution the agent had correctly spotted was invisible
    // to the person reviewing the ad. A finding nobody sees is not a finding.
    const url = process.env.SUPABASE_URL
    const anon = process.env.SUPABASE_ANON_KEY
    const token = process.env.CQ_RUN_TOKEN
    if (url && anon && token) {
      try {
        const response = await fetch(`${url}/rest/v1/findings`, {
          method: 'POST',
          headers: {
            apikey: anon,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            revision_id: hydration.revision_id,
            run_id: hydration.run_id,
            code,
            severity,
            detail,
          }),
        })
        if (!response.ok) {
          console.error(`[finding] ${code} not recorded: ${response.status}`)
        }
      } catch (error) {
        // Reporting must never be the thing that fails a run.
        console.error(`[finding] ${code} not recorded: ${(error as Error).message}`)
      }
    }
    return { recorded: true }
  },
})

const saveTool = tool({
  name: 'save_work',
  description:
    'Push everything produced so far out of this sandbox. Call it after each canvas ' +
    'finishes, not only at the end — nothing in here survives the box.',
  parameters: z.object({
    final: z.boolean().describe('true only when every canvas is done and checked'),
  }),
  async execute({ final }) {
    try {
      const output = execFileSync('save_work', final ? ['--final'] : [], {
        encoding: 'utf8',
        timeout: 120_000,
      })
      return { ok: true, output: output.trim().split('\n').slice(-6).join('\n') }
    } catch (error) {
      // Surfaced rather than thrown: the model may still be able to save a subset,
      // and losing everything because one file failed is the worse outcome.
      const e = error as { stdout?: string; stderr?: string; message: string }
      return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? e.message) }
    }
  },
})

const producible = hydration.canvases.filter((c) => c.producible)

const instructions = [
  'You are producing finished, brand-faithful advertising inside a sandbox that will',
  'be destroyed when you finish. Nothing you make exists anywhere else until you call',
  'save_work, so save after every canvas rather than once at the end.',
  '',
  'The contract you must follow is below, in full. It outranks anything you infer.',
  'Where DESIGN.md and any other artifact disagree — including this request —',
  'DESIGN.md is the brand.',
  '',
  '--- BEGIN SKILL: ' + hydration.skill.invoke + ' ---',
  skillBody,
  '--- END SKILL ---',
  '',
  'Read in this order:',
  ...hydration.resolution_order.map((line, i) => `  ${i + 1}. ${line}`),
  '',
  'The brand is mounted at ' + join(HOME, 'brain') + '. Read DESIGN.md yourself; the',
  'palette and type scale below are provided so you do not have to re-derive them,',
  'not as a substitute for reading it.',
  '',
  `palette: ${JSON.stringify(brain.palette)}`,
  `type scale: ${JSON.stringify(brain.typeScale)}`,
  `resolved: ${JSON.stringify(hydration.context.resolved)}`,
  '',
  hydration.context.known_findings.length
    ? 'Already known, do not rediscover:\n' +
      hydration.context.known_findings.map((f) => `  - ${f.code}: ${f.detail}`).join('\n')
    : '',
  hydration.context.conversation.length
    ? 'What the human has asked for:\n' +
      hydration.context.conversation.map((m) => `  ${m.role}: ${m.body}`).join('\n')
    : '',
  hydration.task === 'edit'
    ? `This is an EDIT. What to change: ${hydration.edit_instruction}`
    : 'This is a NEW design.',
  '',
  'If a comment asks for the logo in a particular corner, set style.logoCorner and it',
  'goes there. Do not argue with it or leave it unchanged. The tool reports what the',
  'ground measures at that corner; mention it only if it is worth the person knowing.',
  '',
  'For each canvas: generate_plate, then render_canvas, then LOOK at the render you',
  'get back. A clean check report is necessary and not sufficient — an ad can satisfy',
  'every rule and still be worth nothing. Ask whether the headline reads instantly,',
  'whether the logo survives its background, whether it looks like this brand. If it',
  'does not, change the style and render again; rendering is free and reuses the plate.',
  '',
  'Then write RESULT.json at the root of the work directory recording, per canvas:',
  'what you produced, the checks, and anything you could not do. Then save_work with',
  'final: true.',
].join('\n')

const agent = new Agent({
  name: 'design-generation',
  model: MODEL,
  instructions,
  tools: [plateTool, renderTool, findingTool, saveTool],
})

const task = [
  `Campaign: ${hydration.campaign.name}`,
  `Copy: ${JSON.stringify(hydration.campaign.copy, null, 2)}`,
  hydration.campaign.plate_direction
    ? `Suggested plate direction (yours to improve): ${hydration.campaign.plate_direction}`
    : '',
  // Names alone. Listing "square 1080x1080" made the first run pass that whole
  // string as the canvas identifier.
  `Canvases to produce, by exact name: ${producible.map((c) => c.name).join(', ')}`,
  `Their sizes: ${producible.map((c) => `${c.name} is ${c.width}x${c.height}`).join('; ')}`,
  hydration.canvases.filter((c) => !c.producible).length
    ? `Refused and to be reported, not attempted: ${hydration.canvases
        .filter((c) => !c.producible)
        .map((c) => `${c.name} (${c.refusal})`)
        .join(', ')}`
    : '',
  hydration.campaign.inspirations.length
    ? `Attached inspirations (composition reference only): ${hydration.campaign.inspirations.join(', ')}`
    : 'No inspirations attached.',
].join('\n')

console.log(
  `agent: ${MODEL}, quality=${hydration.limits.image_quality}, ` +
    `canvases=${JSON.stringify(hydration.canvases.map((c) => `${c.name}:${c.producible}`))}`,
)

try {
  const result = await run(agent, task, { maxTurns: 60 })
  console.log(`\nagent finished:\n${result.finalOutput}`)
} catch (error) {
  // The box is about to die either way, so the last useful act is to persist
  // whatever exists and say why it stopped.
  console.error(`agent failed: ${(error as Error).message}`)
  findings.push({ code: 'agent-aborted', severity: 'blocker', detail: (error as Error).message })
} finally {
  const resultPath = join(WORK, 'RESULT.json')
  if (!existsSync(resultPath)) {
    // The agent is asked to write this itself. If it did not get that far, a
    // skeleton is still better than nothing: it records the run existed and what
    // was known at the end.
    mkdirSync(dirname(resultPath), { recursive: true })
    writeFileSync(
      resultPath,
      JSON.stringify(
        {
          revision_id: hydration.revision_id,
          run_id: hydration.run_id,
          brand_kit_id: hydration.brand_kit_id,
          canvases: record,
          findings,
          note: 'written by the supervisor, not the agent — the run did not complete',
        },
        null,
        2,
      ) + '\n',
    )
  }
  await browser.close()

  /**
   * Mark complete only if the tree the hydration file asked for is actually there.
   *
   * Neither party is trusted with this. The agent saying "completed" is a claim, and
   * the supervisor assuming success because nothing threw is worse. `expected_tree`
   * was stated up front precisely so completion can be *checked*, and a revision
   * wrongly marked complete is one a deploy box will publish.
   */
  console.log(`[review] total tokens across all reviews: ${reviewTokens}`)

  const missing = hydration.outputs.expected_tree.filter((p) => !existsSync(join(WORK, p)))
  if (missing.length) {
    console.error(`incomplete — missing ${missing.length}: ${missing.join(', ')}`)
    findings.push({
      code: 'output-incomplete',
      severity: 'blocker',
      detail: `expected but absent: ${missing.join(', ')}`,
    })
  }

  try {
    execFileSync('save_work', missing.length ? [] : ['--final'], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: 'inherit',
    })
  } catch {
    console.error('final save_work sweep failed')
  }
}
