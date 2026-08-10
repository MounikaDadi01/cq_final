import { describe, expect, it } from 'vitest'
import { GPT_IMAGE_2, isRequestable, planGeneration } from '../src/capability'
import { canvasesFromPacket } from './fixtures'

describe('image model envelope', () => {
  it('accepts a size that satisfies every rule', () => {
    expect(isRequestable(1024, 1024, GPT_IMAGE_2).ok).toBe(true)
  })

  it('rejects an edge that is not a multiple of the required step', () => {
    const result = isRequestable(1080, 1080, GPT_IMAGE_2)
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/multiples of 16/)
  })

  it('rejects an aspect ratio beyond the ceiling', () => {
    const result = isRequestable(2304, 288, GPT_IMAGE_2)
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/exceeds 3:1/)
  })

  it('rejects a size below the pixel floor', () => {
    const result = isRequestable(320, 320, GPT_IMAGE_2)
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/below minimum/)
  })

  it('rejects an edge beyond the maximum', () => {
    const result = isRequestable(3856, 1280, GPT_IMAGE_2)
    expect(result.ok).toBe(false)
    expect(result.reasons.join(' ')).toMatch(/exceeds 3840/)
  })
})

describe('generation planning for the canvases the packet actually requests', () => {
  const canvases = canvasesFromPacket()

  it('finds canvases in the packet rather than assuming them', () => {
    expect(canvases.length).toBeGreaterThan(0)
  })

  it('no required canvas can be requested from the model directly', () => {
    // Every one fails the multiple-of-16 rule, which is why planning exists.
    for (const canvas of canvases) {
      expect(isRequestable(canvas.width, canvas.height, GPT_IMAGE_2).ok).toBe(false)
    }
  })

  it.each(canvases)('plans %s without distorting it, or refuses with a reason', (canvas) => {
    const plan = planGeneration(canvas.width, canvas.height, GPT_IMAGE_2)

    if (!plan.ok) {
      // A refusal has to explain itself well enough for an operator to act on.
      expect(plan.reasons.join(' ')).toMatch(/\d/)
      expect(plan.reasons.join(' ').length).toBeGreaterThan(20)
      return
    }

    // Whatever we generate must itself be legal.
    expect(isRequestable(plan.generateWidth, plan.generateHeight, GPT_IMAGE_2).ok).toBe(true)
    // Always downscale, never upscale.
    expect(plan.generateWidth).toBeGreaterThanOrEqual(canvas.width)
    expect(plan.generateHeight).toBeGreaterThanOrEqual(canvas.height)
    // Anisotropy has to be invisible: a tenth of a percent is a fifth of a pixel
    // across a thousand.
    expect(plan.anisotropy).toBeLessThan(0.001)
  })
})

describe('the canvas that cannot be served', () => {
  it('refuses an aspect beyond the ceiling no matter what size is generated', () => {
    const plan = planGeneration(728, 90, GPT_IMAGE_2)
    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.reasons.join(' ')).toMatch(/8\.09:1|exceeds the 3:1/)
    }
  })

  it('produces an exact-aspect plan where one exists', () => {
    for (const [w, h] of [
      [1080, 1080],
      [1080, 1350],
    ] as const) {
      const plan = planGeneration(w, h, GPT_IMAGE_2)
      expect(plan.ok).toBe(true)
      if (plan.ok) {
        expect(plan.aspectExact).toBe(true)
        expect(plan.anisotropy).toBe(0)
      }
    }
  })

  it('accepts a near-exact plan where no exact aspect is legal', () => {
    const plan = planGeneration(1200, 628, GPT_IMAGE_2)
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.aspectExact).toBe(false)
      expect(plan.anisotropy).toBeGreaterThan(0)
      expect(plan.anisotropy).toBeLessThan(0.0005)
    }
  })
})
