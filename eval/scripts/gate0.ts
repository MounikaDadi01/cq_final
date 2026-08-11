/**
 * Gate 0: produce real ads on disk so a person can look at them.
 *
 * Follows AdGeneration.md and SKILL.md: resolve the brand, generate a plate per
 * canvas size, overlay the copy as live HTML, render the canvas. Every plate is a
 * separate generation — one plate per canvas size, never adapted.
 *
 * Output mirrors SKILL.md's own convention, `html_<slug>/assets/`, so the tree on
 * disk is the tree that would be saved.
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { discoverBrains, paletteExtremes, resolveFamily, resolveScaleValue, type Brain } from '../src/brain'
import { GPT_IMAGE_2, planGeneration } from '../src/capability'
import { blockers, discoverCampaigns, findings, validateCampaign, type Campaign, type CampaignCanvas } from '../src/campaign'
import { runAllChecks, failures, unverified, measureContrast, checkPixelFidelity, type ArtifactBundle } from '../src/checks'
import { createOpenAIImageCaller, readEnvFile } from '../src/openai-image'
import { buildOverlay, type CampaignStyle } from '../src/overlay'
import { contrastRatio, decodePng, dominantColour, encodePng, type Box, type Raster } from '../src/png'
import { generatePlate, PlateImpossible, classifyImageFailure, type Quality } from '../src/plate'
import { launchBrowser, renderCanvas, verifyFonts, type MeasuredElement } from '../src/render'

const ROOT = resolve(import.meta.dirname, '..', '..')
const OUT = join(ROOT, process.env.CQ_OUT ?? 'image_testing')
const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env }
const QUALITY = (process.env.CQ_QUALITY ?? 'high') as Quality
/**
 * Reuse the plates already on disk and only rebuild the overlay and render.
 *
 * Plates cost money and two minutes each; a layout change costs neither. Keeping
 * them separable means iterating on type, spacing or logo placement is free, which
 * is the difference between trying three arrangements and settling for the first.
 */
const RENDER_ONLY = process.argv.includes('--render-only')

const brains = discoverBrains(join(ROOT, 'packet', 'design-brains'))
const campaigns = discoverCampaigns(join(ROOT, 'campaigns')).filter((c) => c.kind === 'new')
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const selected = only.length ? campaigns.filter((c) => only.includes(c.id)) : campaigns

if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing from .env')

const call = createOpenAIImageCaller({
  apiKey: env.OPENAI_API_KEY,
  model: env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
  timeoutMs: 300_000,
})

/**
 * The generation prompt contract: composition, subject, lighting, palette,
 * texture, negative space and the exact aspect — then the prohibitions, stated
 * every time. The model is never asked to render a word or reproduce a logo.
 */
function platePrompt(
  campaign: Campaign,
  brain: Brain,
  w: number,
  h: number,
  referenceCount: number,
): string {
  const palette = Object.entries(brain.palette).map(([k, v]) => `${k} ${v}`).join(', ')
  // SKILL.md pulls in two directions here: "supply brand colours and reference
  // imagery", and "do not sample colours from an inspiration". Both hold only if
  // the reference is explicitly bounded to composition — which matters because
  // one kit's own inspiration breaks that kit's palette rule, and every
  // inspiration in this packet contains type and a wordmark.
  const referenceClause =
    referenceCount > 0
      ? [
          `${referenceCount} reference image${referenceCount > 1 ? 's are' : ' is'} attached.`,
          'Use them ONLY for composition, rhythm, crop, framing and where empty space falls.',
          'Do not copy their colours — the palette above governs and overrides anything',
          'the references show. Do not copy any text, wordmark, logo, badge or button',
          'from them. Do not reproduce their subject matter literally.',
        ].join(' ')
      : ''
  return [
    campaign.plateDirection ?? '',
    `Aspect ratio exactly ${w}:${h}, filling the frame edge to edge with no border.`,
    `Brand palette to work within: ${palette}.`,
    referenceClause,
    'This is a background plate only. It must contain absolutely no words, letters,',
    'numbers, captions, logos, wordmarks, badges, buttons, button labels, UI text,',
    'watermarks, signatures or any typography of any kind. Leave the described',
    'negative space genuinely empty — do not fill it with detail, and do not add',
    'placeholder text where copy will go.',
  ].join(' ')
}

/** Maps a copied asset filename back to its manifest path. */
const logoManifestPath = (brain: Brain, src: string) =>
  brain.assets.find((a) => a.path.endsWith(src))?.path

const brandOf = (c: Campaign) => {
  const b = brains.find((x) => x.kitId === c.brandKitId)
  if (!b) throw new Error(`no brain for ${c.brandKitId}`)
  return b
}

/** WCAG's large-text floor. Ad headlines are large type, so 3:1 is the bar. */
const READABLE_RATIO = 3

/**
 * The palette end that reads best against a measured background.
 *
 * Only the brand's own light and dark ends are candidates — correcting a contrast
 * problem must not invent a colour the brand never published.
 */
function mostReadableAgainst(behind: string, brain: Brain, prefer: string | null): string | null {
  // A correction that clears the bar should stay with the colour the rest of the
  // copy uses. Picking the strictly highest ratio put a white eyebrow above an
  // ink headline on one plate — both readable, but visibly two decisions.
  if (prefer && contrastRatio(prefer, behind) >= READABLE_RATIO) return prefer
  const extremes = paletteExtremes(brain)
  const candidates = extremes ? [extremes.lightest, extremes.darkest] : []
  let best: { hex: string; ratio: number } | null = null
  for (const hex of candidates) {
    const ratio = contrastRatio(hex, behind)
    if (!best || ratio > best.ratio) best = { hex, ratio }
  }
  return best?.hex ?? null
}

/**
 * What is really behind a line of text.
 *
 * Sampling the rendered box conflates the glyphs with their background — a white
 * headline made its own box read as white, so a contrast reading of 1.0 meant
 * "text against itself" rather than anything about legibility. The plate carries
 * no type by construction, so the plate under the box is the background, full
 * stop, and the reading stops depending on the answer it is trying to produce.
 */
const backgroundUnder = (plateRaster: Raster, box: Box) =>
  dominantColour(plateRaster, {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
  })

const results: Record<string, unknown>[] = []
const browser = await launchBrowser()
let spent = 0

console.log(`\ngate 0 · ${selected.length} campaigns · quality=${QUALITY}\n`)

for (const campaign of selected) {
  const brain = brandOf(campaign)
  const style = campaign.style as CampaignStyle
  const issues = validateCampaign(campaign, brains, join(ROOT, 'packet'))
  if (blockers(issues).length) {
    console.error(`✗ ${campaign.id} blocked:`, blockers(issues))
    continue
  }

  const heading = resolveFamily(brain, brain.type.heading ?? '')
  const body = resolveFamily(brain, brain.type.body ?? '')
  const h1 = resolveScaleValue(brain, 'h1')
  const campaignDir = join(OUT, campaign.id)
  const canvasRecords: Record<string, unknown>[] = []
  const record: Record<string, unknown> = {
    campaign: campaign.id,
    brand_kit_id: campaign.brandKitId,
    quality: QUALITY,
    headline: campaign.copy.headline,
    resolved: {
      heading_family: heading.resolvedFamilySlug,
      heading_substituted: heading.substituted,
      heading_note: heading.reason ?? null,
      body_family: body.resolvedFamilySlug,
      h1: h1 ? `${h1.value} (${h1.source}${h1.contested ? ', contested' : ''})` : null,
    },
    canvases: canvasRecords,
    findings: findings(issues).map((i) => `${i.field}: ${i.detail}`),
  }

  console.log(`── ${campaign.id}  [${brain.slug}]`)

  for (const canvas of campaign.canvases) {
    const plan = planGeneration(canvas.width, canvas.height, GPT_IMAGE_2)
    if (!plan.ok) {
      console.log(`   ${canvas.name.padEnd(10)} skipped — ${plan.reasons[0]}`)
      canvasRecords.push({ canvas: canvas.name, skipped: true, reasons: plan.reasons })
      continue
    }

    const slug = canvas.name
    const htmlDir = join(campaignDir, `html_${slug}`)
    mkdirSync(join(htmlDir, 'assets'), { recursive: true })
    mkdirSync(join(campaignDir, 'renders'), { recursive: true })

    // Attach whatever the request named, by exact filename. SKILL.md: "Consult one
    // only when the request attaches it by filename" — a file merely sitting in the
    // directory is not selected.
    const referenceImages = campaign.inspirations.map((name) =>
      readFileSync(join(ROOT, 'packet', 'inspirations', name)),
    )

    const started = Date.now()
    let plate
    if (RENDER_ONLY) {
      const existing = join(htmlDir, 'assets', 'plate.png')
      if (!existsSync(existing)) {
        console.log(`   ${slug.padEnd(10)} no plate on disk — run without --render-only first`)
        continue
      }
      const raster = decodePng(readFileSync(existing))
      plate = {
        raster,
        generatedWidth: plan.generateWidth,
        generatedHeight: plan.generateHeight,
        scaleX: plan.scaleX,
        scaleY: plan.scaleY,
        anisotropy: plan.anisotropy,
        aspectExact: plan.aspectExact,
        quality: QUALITY,
        edited: false,
      }
    } else {
    try {
      plate = await generatePlate(
        {
          targetWidth: canvas.width,
          targetHeight: canvas.height,
          prompt: platePrompt(campaign, brain, canvas.width, canvas.height, referenceImages.length),
          quality: QUALITY,
          referenceImages,
        },
        call,
      )
    } catch (error) {
      if (error instanceof PlateImpossible) throw error
      const f = classifyImageFailure(error)
      console.log(`   ${slug.padEnd(10)} FAILED [${f.kind}] ${f.hint}`)
      canvasRecords.push({ canvas: slug, failed: true, kind: f.kind, hint: f.hint })
      continue
    }
    spent++
      writeFileSync(join(htmlDir, 'assets', 'plate.png'), encodePng(plate.raster))
    }

    const htmlPath = join(htmlDir, 'index.html')
    const build = (forcedTextColours: Record<string, string>) =>
      buildOverlay({
        brain, campaign, canvas, style,
        platePath: 'assets/plate.png',
        headingSlug: heading.resolvedFamilySlug ?? body.resolvedFamilySlug ?? '',
        bodySlug: body.resolvedFamilySlug ?? '',
        plateRaster: plate.raster,
        forcedTextColours,
      })
    const draw = async (forced: Record<string, string>) => {
      const overlay = build(forced)
      if (overlay.logoPath && existsSync(overlay.logoPath)) {
        copyFileSync(overlay.logoPath, join(htmlDir, basename(overlay.logoPath)))
      }
      writeFileSync(htmlPath, overlay.html)
      const render = await renderCanvas({
        htmlPath, width: canvas.width, height: canvas.height,
        expectedFaces: overlay.expectedFaces, browser,
      })
      return { overlay, render }
    }

    /**
     * Redraw any line that can't be read against the plate beneath it.
     *
     * Choosing text colour from the average brightness of the whole copy band is
     * a prediction, and on a plate that is bright one side and shadowed the other
     * it predicts wrongly — a band averaging 0.274 put near-black type onto a
     * near-black patch. The first render supplies the true box of every line, the
     * plate supplies what is under it, and any line below the readable ratio is
     * redrawn in whichever end of the brand's own palette actually contrasts.
     */
    let { overlay, render } = await draw({})
    /** The colour the measured ground already chose for ordinary copy. */
    const groundColour =
      (() => {
        const e = paletteExtremes(brain)
        if (!e) return null
        return overlay.copyGround.treatedAs === 'dark' ? e.lightest : e.darkest
      })()
    const corrections: Record<string, string> = {}
    const correctionNotes: string[] = []
    for (const el of render.elements) {
      if (el.role !== 'text' || !el.line) continue
      const declared = el.colours[0]
      if (!declared) continue
      const behind = backgroundUnder(plate.raster, el.box)
      const ratio = contrastRatio(declared, behind)
      if (ratio >= READABLE_RATIO) continue
      const better = mostReadableAgainst(behind, brain, groundColour)
      if (!better || better === declared) {
        correctionNotes.push(
          `${el.line}: ${declared} on ${behind} is ${ratio.toFixed(2)}:1 and no palette colour reads better`,
        )
        continue
      }
      corrections[el.line] = better
      correctionNotes.push(
        `${el.line}: ${declared} on ${behind} was ${ratio.toFixed(2)}:1 → ${better} ` +
        `at ${contrastRatio(better, behind).toFixed(2)}:1`,
      )
    }
    if (Object.keys(corrections).length) {
      const redone = await draw(corrections)
      overlay = redone.overlay
      render = redone.render
    }

    const renderPath = join(campaignDir, 'renders', `${slug}.png`)
    writeFileSync(renderPath, render.png)

    const fonts = verifyFonts(render)

    const bundle: ArtifactBundle = {
      canvas,
      plate: {
        width: canvas.width, height: canvas.height,
        generatedWidth: plate.generatedWidth, generatedHeight: plate.generatedHeight,
      },
      brandKitId: campaign.brandKitId,
      requiredStrings: [campaign.copy.headline, campaign.copy.cta].filter(Boolean) as string[],
      // Straight from the render, so the checks inspect the artifact rather than
      // our intentions. An empty array here silently passed everything.
      overlay: render.elements.map((el) => ({
        role: el.role,
        box: el.box,
        text: el.text,
        fontFamily: el.familySlug,
        declaredColours: el.colours,
        expectedDominantColour: el.role === 'cta' ? el.colours.find((c) => c !== '#FFFFFF') : undefined,
        assetPath: el.src ? logoManifestPath(brain, el.src) : undefined,
        renderedWidth: el.role === 'logo' ? el.box.width : undefined,
        renderedHeight: el.role === 'logo' ? el.box.height : undefined,
      })),
    }
    // An outlined button carries its colour in a 2px border and the label, so a
    // threshold meant for a solid fill flags it wrongly. The style says which it
    // is, so the threshold follows.
    const ctaIsOutlined = style.cta.fill === 'none'
    const checks = [
      ...runAllChecks(bundle, brain, render.raster).filter((c) => c.check !== 'pixel-fidelity'),
      ...checkPixelFidelity(bundle, render.raster, ctaIsOutlined ? 0.03 : 0.35),
    ]
    // Only the text colour is worth a ratio. Measuring a fill against a box it
    // fills returns 1.0, which is arithmetic rather than information.
    // Measured against the plate for the same reason the corrections are: the
    // render's own glyphs would otherwise count as their own background.
    const contrast = render.elements
      .filter((el) => el.colours[0])
      .map((el) => {
        const behind = backgroundUnder(plate.raster, el.box)
        return {
          role: el.role,
          line: el.line ?? null,
          declaredColour: el.colours[0],
          behindColour: behind,
          ratio: Number(contrastRatio(el.colours[0], behind).toFixed(2)),
        }
      })

    const secs = ((Date.now() - started) / 1000).toFixed(1)
    const fontMark = fonts.ok ? '✓' : '✗'
    console.log(
      `   ${slug.padEnd(10)} ${canvas.width}x${canvas.height} ` +
      `gen ${plate.generatedWidth}x${plate.generatedHeight} ` +
      `aniso ${(plate.anisotropy * 100).toFixed(4)}%  fonts ${fontMark}  ${secs}s`,
    )
    if (!fonts.ok) for (const p of fonts.problems) console.log(`      ! ${p}`)

    canvasRecords.push({
      canvas: slug,
      target: `${canvas.width}x${canvas.height}`,
      generated: `${plate.generatedWidth}x${plate.generatedHeight}`,
      anisotropy_pct: Number((plate.anisotropy * 100).toFixed(4)),
      render: `renders/${slug}.png`,
      plate: `html_${slug}/assets/plate.png`,
      html: `html_${slug}/index.html`,
      fonts_ok: fonts.ok,
      font_problems: fonts.problems,
      computed_fonts: render.computed,
      logo: overlay.logoPath ? basename(overlay.logoPath) : null,
      logo_reason: overlay.logoNote,
      logo_corner: overlay.logoCorner,
      logo_corners_considered: overlay.logoConsidered,
      logo_ground: overlay.logoGround,
      inspirations_attached: campaign.inspirations,
      copy_ground: overlay.copyGround,
      text_colour_corrections: correctionNotes,
      measured: render.elements.map((e) => ({ role: e.role, line: e.line, box: e.box, colours: e.colours })),
      check_failures: failures(checks).map((f) => `${f.check}: ${f.detail}`),
      check_unverifiable: unverified(checks).map((f) => `${f.check}: ${f.detail}`),
      contrast,
      seconds: Number(secs),
    })
  }

  mkdirSync(campaignDir, { recursive: true })
  writeFileSync(join(campaignDir, 'RESULT.json'), JSON.stringify(record, null, 2) + '\n')
  results.push(record)
}

await browser.close()
writeFileSync(join(OUT, 'RESULT.json'), JSON.stringify({ campaigns: results }, null, 2) + '\n')
console.log(`\n${spent} plates generated · output in image_testing/\n`)
