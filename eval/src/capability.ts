/**
 * An image model's size envelope, expressed as data.
 *
 * This lives in a table row in production (`image_model_capabilities`) so that a
 * model with wider support is a data change rather than a code change. Nothing
 * here knows about a specific canvas or a specific brand.
 */
export interface Envelope {
  name: string
  /** Both edges must be a multiple of this. */
  edgeMultiple: number
  /** Long edge divided by short edge may not exceed this. */
  maxRatio: number
  minPixels: number
  maxPixels: number
  maxEdge: number
  /** Some models refuse a transparent background. */
  supportsTransparency: boolean
}

/**
 * Published constraints for gpt-image-2 custom sizes.
 *
 * Source: the OpenAI image generation guide, kept in the repo at
 * `open-ai-docs.md` — "Maximum edge length must be less than or equal to 3840px /
 * Both edges must be multiples of 16px / Long edge to short edge ratio must not
 * exceed 3:1 / Total pixels must be at least 655,360 and no more than 8,294,400".
 *
 * Also from there: no transparent background for this model, and outputs above
 * 2560x1440 are flagged experimental — which none of our canvases approach.
 */
export const GPT_IMAGE_2: Envelope = {
  name: 'gpt-image-2',
  edgeMultiple: 16,
  maxRatio: 3,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxEdge: 3840,
  supportsTransparency: false,
}

export interface Requestable {
  ok: boolean
  reasons: string[]
}

/** Can this exact size be asked of the model? */
export function isRequestable(width: number, height: number, env: Envelope): Requestable {
  const reasons: string[] = []
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return { ok: false, reasons: ['width and height must be positive integers'] }
  }
  if (width % env.edgeMultiple || height % env.edgeMultiple) {
    reasons.push(`edges must be multiples of ${env.edgeMultiple} (got ${width}x${height})`)
  }
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const ratio = long / short
  if (ratio > env.maxRatio) {
    reasons.push(`ratio ${ratio.toFixed(2)}:1 exceeds ${env.maxRatio}:1`)
  }
  const pixels = width * height
  if (pixels < env.minPixels) reasons.push(`${pixels} px below minimum ${env.minPixels}`)
  if (pixels > env.maxPixels) reasons.push(`${pixels} px above maximum ${env.maxPixels}`)
  if (long > env.maxEdge) reasons.push(`edge ${long} exceeds ${env.maxEdge}`)
  return { ok: reasons.length === 0, reasons }
}

export interface GenerationPlan {
  ok: true
  targetWidth: number
  targetHeight: number
  generateWidth: number
  generateHeight: number
  scaleX: number
  scaleY: number
  /** 0 when the generation aspect matches the target exactly. */
  anisotropy: number
  aspectExact: boolean
}

export interface GenerationBlocked {
  ok: false
  targetWidth: number
  targetHeight: number
  reasons: string[]
}

/**
 * Choose what to ask the model for, given a target canvas.
 *
 * Always generates at or above the target so the plate is downscaled, never
 * upscaled: downscaling discards detail, upscaling invents it. Prefers an exact
 * aspect match, then the smallest pixel count, so anisotropy is zero wherever
 * an exact match exists.
 */
export function planGeneration(
  targetWidth: number,
  targetHeight: number,
  env: Envelope,
): GenerationPlan | GenerationBlocked {
  const target = targetWidth / targetHeight
  const long = Math.max(targetWidth, targetHeight)
  const short = Math.min(targetWidth, targetHeight)

  // A target whose own aspect breaches the ratio ceiling can never be served,
  // no matter what size we generate at, because the ceiling binds the request.
  if (long / short > env.maxRatio) {
    return {
      ok: false,
      targetWidth,
      targetHeight,
      reasons: [
        `target aspect ${(long / short).toFixed(2)}:1 exceeds the ${env.maxRatio}:1 ceiling, ` +
          `which binds the requested output size on both generate and edit`,
      ],
    }
  }

  const steps = Math.floor(env.maxEdge / env.edgeMultiple)
  let best: GenerationPlan | null = null

  for (let a = 1; a <= steps; a++) {
    const w = a * env.edgeMultiple
    if (w < targetWidth) continue
    for (let b = 1; b <= steps; b++) {
      const h = b * env.edgeMultiple
      if (h < targetHeight) continue
      if (!isRequestable(w, h, env).ok) continue

      const err = Math.abs(w / h - target) / target
      const scaleX = targetWidth / w
      const scaleY = targetHeight / h
      const candidate: GenerationPlan = {
        ok: true,
        targetWidth,
        targetHeight,
        generateWidth: w,
        generateHeight: h,
        scaleX,
        scaleY,
        anisotropy: Math.abs(scaleX / scaleY - 1),
        aspectExact: err === 0,
      }
      if (
        best === null ||
        err < Math.abs(best.generateWidth / best.generateHeight - target) / target - 1e-15 ||
        (Math.abs(
          err - Math.abs(best.generateWidth / best.generateHeight - target) / target,
        ) < 1e-15 &&
          w * h < best.generateWidth * best.generateHeight)
      ) {
        best = candidate
      }
    }
  }

  if (!best) {
    return {
      ok: false,
      targetWidth,
      targetHeight,
      reasons: ['no legal generation size is at or above the target'],
    }
  }
  return best
}
