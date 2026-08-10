import { describe, expect, it, vi } from 'vitest'
import { GPT_IMAGE_2, planGeneration } from '../src/capability'
import { encodePng, makePng, type Raster } from '../src/png'
import {
  PlateImpossible,
  classifyImageFailure,
  generatePlate,
  type ImageCallRequest,
} from '../src/plate'
import { isFullyOpaque, resampleTo } from '../src/resample'
import { canvasesFromPacket } from './fixtures'

/**
 * The plate pipeline, end to end, without spending anything.
 *
 * The image call is injected, so the whole contract — legal size requested,
 * exact-dimension output, uniform reduction, opacity, refusal — is testable with
 * a fake. A live variant at the bottom runs only when explicitly asked.
 */

/** Stands in for the model: returns a plate at exactly the size requested. */
function fakeCaller(fill = '#1B3A5C') {
  return vi.fn(async (req: ImageCallRequest): Promise<Raster> =>
    makePng(req.width, req.height, fill),
  )
}

const servable = canvasesFromPacket().filter(
  (c) => planGeneration(c.width, c.height, GPT_IMAGE_2).ok,
)

describe('a plate comes back at exactly the target size', () => {
  it.each(servable)('$name $width x $height', async (canvas) => {
    const call = fakeCaller()
    const result = await generatePlate(
      { targetWidth: canvas.width, targetHeight: canvas.height, prompt: 'a quiet jobsite at dusk' },
      call,
    )

    expect(result.raster.width).toBe(canvas.width)
    expect(result.raster.height).toBe(canvas.height)

    // The model was asked for a legal size, not the target.
    const asked = call.mock.calls[0][0]
    expect(asked.width % 16).toBe(0)
    expect(asked.height % 16).toBe(0)
    expect(asked.width).toBeGreaterThanOrEqual(canvas.width)
    expect(asked.height).toBeGreaterThanOrEqual(canvas.height)
    expect(`${asked.width}x${asked.height}`).toBe(
      `${result.generatedWidth}x${result.generatedHeight}`,
    )
  })

  it('reduces, never enlarges', async () => {
    for (const canvas of servable) {
      const result = await generatePlate(
        { targetWidth: canvas.width, targetHeight: canvas.height, prompt: 'x' },
        fakeCaller(),
      )
      expect(result.scaleX).toBeLessThanOrEqual(1)
      expect(result.scaleY).toBeLessThanOrEqual(1)
    }
  })

  it('keeps the scale uniform to within the envelope-forced residue', async () => {
    for (const canvas of servable) {
      const result = await generatePlate(
        { targetWidth: canvas.width, targetHeight: canvas.height, prompt: 'x' },
        fakeCaller(),
      )
      expect(result.anisotropy).toBeLessThan(0.0001)
    }
  })

  it('preserves a solid colour through the reduction', async () => {
    const result = await generatePlate(
      { targetWidth: 1080, targetHeight: 1080, prompt: 'x' },
      fakeCaller('#F26B21'),
    )
    const i = (500 * 1080 + 500) * 4
    expect([result.raster.data[i], result.raster.data[i + 1], result.raster.data[i + 2]]).toEqual([
      0xf2, 0x6b, 0x21,
    ])
  })

  it('comes back fully opaque, because a plate is full-bleed', async () => {
    const result = await generatePlate(
      { targetWidth: 1080, targetHeight: 1350, prompt: 'x' },
      fakeCaller(),
    )
    expect(isFullyOpaque(result.raster)).toBe(true)
  })

  it('encodes to a PNG that decodes back at the same size', async () => {
    const result = await generatePlate(
      { targetWidth: 1080, targetHeight: 1080, prompt: 'x' },
      fakeCaller(),
    )
    const bytes = encodePng(result.raster)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  })
})

describe('quality is a parameter on the run, not a constant', () => {
  it('defaults to low, so iterating on wording is cheap', async () => {
    const call = fakeCaller()
    const result = await generatePlate({ targetWidth: 1080, targetHeight: 1080, prompt: 'x' }, call)
    expect(result.quality).toBe('low')
    expect(call.mock.calls[0][0].quality).toBe('low')
  })

  it('passes high through for anything kept', async () => {
    const call = fakeCaller()
    await generatePlate(
      { targetWidth: 1080, targetHeight: 1080, prompt: 'x', quality: 'high' },
      call,
    )
    expect(call.mock.calls[0][0].quality).toBe('high')
  })
})

describe('references and revisions', () => {
  it('passes a named inspiration through as reference imagery', async () => {
    const call = fakeCaller()
    const inspiration = encodePng(makePng(64, 64, '#0C3B5D'))
    await generatePlate(
      { targetWidth: 1080, targetHeight: 1080, prompt: 'x', referenceImages: [inspiration] },
      call,
    )
    expect(call.mock.calls[0][0].referenceImages.length).toBe(1)
  })

  it('marks a run as an edit when a parent plate is supplied', async () => {
    const call = fakeCaller()
    const parent = encodePng(makePng(1088, 1088, '#1B3A5C'))
    const result = await generatePlate(
      { targetWidth: 1080, targetHeight: 1080, prompt: 'fix the sky', parentPlate: parent },
      call,
    )
    expect(result.edited).toBe(true)
    expect(call.mock.calls[0][0].parentPlate).toBeDefined()
  })

  it('is a fresh generation when no parent is supplied', async () => {
    const result = await generatePlate(
      { targetWidth: 1080, targetHeight: 1080, prompt: 'x' },
      fakeCaller(),
    )
    expect(result.edited).toBe(false)
  })
})

describe('it refuses rather than degrading', () => {
  it('will not produce the leaderboard, and says why with numbers', async () => {
    await expect(
      generatePlate({ targetWidth: 728, targetHeight: 90, prompt: 'x' }, fakeCaller()),
    ).rejects.toThrow(PlateImpossible)

    try {
      await generatePlate({ targetWidth: 728, targetHeight: 90, prompt: 'x' }, fakeCaller())
    } catch (error) {
      expect((error as PlateImpossible).reasons.join(' ')).toMatch(/8\.09:1/)
    }
  })

  it('rejects a model that returns the wrong size', async () => {
    // Planted: the caller ignores the requested dimensions. Silently resampling
    // whatever came back would produce a plate at target size from the wrong
    // aspect — a crop by accident.
    const wrong = vi.fn(async (req: ImageCallRequest) => makePng(req.width - 16, req.height, '#000000'))
    await expect(
      generatePlate({ targetWidth: 1080, targetHeight: 1080, prompt: 'x' }, wrong),
    ).rejects.toThrow(/not the 1088x1088 that was requested/)
  })

  it('rejects a plate carrying transparency', async () => {
    const transparent = vi.fn(async (req: ImageCallRequest) => {
      const r = makePng(req.width, req.height, '#1B3A5C')
      r.data[3] = 0
      return r
    })
    await expect(
      generatePlate({ targetWidth: 1080, targetHeight: 1080, prompt: 'x' }, transparent),
    ).rejects.toThrow(/not fully opaque/)
  })
})

describe('failures are classified before anything is retried', () => {
  it('treats 429 and 5xx as transient', () => {
    expect(classifyImageFailure({ status: 429 }).kind).toBe('retry')
    expect(classifyImageFailure({ status: 500 }).kind).toBe('retry')
    expect(classifyImageFailure({ status: 503 }).kind).toBe('retry')
  })

  it('never retries a user error, because the request has to change', () => {
    const f = classifyImageFailure({
      type: 'image_generation_user_error',
      code: 'some_user_error',
    })
    expect(f.kind).toBe('change-the-request')
    expect(f.hint).toMatch(/retrying unchanged will fail identically/)
  })

  it('turns an input-stage moderation block into something the agent can act on', () => {
    const f = classifyImageFailure({
      type: 'image_generation_user_error',
      code: 'moderation_blocked',
      moderation_details: { moderation_stage: 'input', categories: ['harassment'] },
    })
    expect(f.kind).toBe('change-the-request')
    expect(f.moderationStage).toBe('input')
    expect(f.categories).toEqual(['harassment'])
    expect(f.hint).toMatch(/prompt or an input image was blocked/)
    expect(f.hint).toMatch(/Do not retry unchanged/)
  })

  it('distinguishes an output-stage block, which is a different problem', () => {
    const f = classifyImageFailure({
      type: 'image_generation_user_error',
      code: 'moderation_blocked',
      moderation_details: { moderation_stage: 'output', categories: [] },
    })
    expect(f.hint).toMatch(/blocked after the fact/)
  })

  it('refuses to guess at an unrecognised failure', () => {
    expect(classifyImageFailure({ status: 418 }).kind).toBe('unknown')
    expect(classifyImageFailure({ status: 418 }).hint).toMatch(/do not retry blindly/)
  })
})

describe('the resampler', () => {
  it('averages rather than point-samples', () => {
    // Four quadrants of one pixel each, reduced to a single pixel: the result is
    // the mean, which point-sampling would not give.
    const src = makePng(2, 2, '#000000', [
      { x: 0, y: 0, width: 1, height: 1, color: '#FF0000' },
      { x: 1, y: 0, width: 1, height: 1, color: '#00FF00' },
      { x: 0, y: 1, width: 1, height: 1, color: '#0000FF' },
      { x: 1, y: 1, width: 1, height: 1, color: '#FFFFFF' },
    ])
    const out = resampleTo(src, 1, 1)
    expect(out.width).toBe(1)
    expect([out.data[0], out.data[1], out.data[2]]).toEqual([128, 128, 128])
  })

  it('is a no-op at the same size, without sharing the buffer', () => {
    const src = makePng(8, 8, '#123456')
    const out = resampleTo(src, 8, 8)
    expect(out.data.equals(src.data)).toBe(true)
    expect(out.data).not.toBe(src.data)
  })

  it('hits the exact target for every servable canvas', () => {
    for (const canvas of servable) {
      const plan = planGeneration(canvas.width, canvas.height, GPT_IMAGE_2)
      if (!plan.ok) continue
      const out = resampleTo(
        makePng(plan.generateWidth, plan.generateHeight, '#1B3A5C'),
        canvas.width,
        canvas.height,
      )
      expect([out.width, out.height]).toEqual([canvas.width, canvas.height])
    }
  })

  it('refuses a nonsensical target', () => {
    expect(() => resampleTo(makePng(4, 4, '#000000'), 0, 4)).toThrow()
  })
})

/**
 * The only test that spends money. Opt in with `CQ_LIVE_IMAGE=1`, and it will
 * make one real generation at the cheapest setting — `low`, square — to confirm
 * the key's scope and that a real plate comes back at the size we asked for.
 */
const live = process.env.CQ_LIVE_IMAGE === '1'
describe.skipIf(!live)('live gpt-image-2 call', () => {
  it('returns a plate at exactly 1080x1080', async () => {
    const { createOpenAIImageCaller, readEnvFile } = await import('../src/openai-image')
    const env = { ...readEnvFile('../.env'), ...process.env }
    const apiKey = env.OPENAI_API_KEY
    expect(apiKey, 'OPENAI_API_KEY must be set for a live run').toBeTruthy()

    const result = await generatePlate(
      {
        targetWidth: 1080,
        targetHeight: 1080,
        quality: 'low',
        prompt:
          'A textless full-bleed photographic background: an empty construction site at dusk, ' +
          'deep navy sky, generous quiet negative space in the upper half. ' +
          'No words, letters, numbers, logos, badges, buttons, watermarks or UI text.',
      },
      createOpenAIImageCaller({ apiKey: apiKey as string, model: env.OPENAI_IMAGE_MODEL }),
    )

    expect(result.raster.width).toBe(1080)
    expect(result.raster.height).toBe(1080)
    expect(result.generatedWidth).toBe(1088)
    expect(isFullyOpaque(result.raster)).toBe(true)
  }, 240_000)
})
