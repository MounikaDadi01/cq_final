import { GPT_IMAGE_2, planGeneration, type Envelope } from './capability'
import type { Raster } from './png'
import { isFullyOpaque, resampleTo } from './resample'

/**
 * The plate pipeline: plan a legal size, generate, reduce to exact target.
 *
 * The image call is injected rather than imported, and that seam is the point.
 * Offline it returns a synthetic raster at the requested size, so the dimension
 * and compliance contract is testable without spending money or needing a key.
 * Live it calls the images endpoint. Neither path knows which it is.
 */

export type Quality = 'low' | 'medium' | 'high'

export interface PlateRequest {
  targetWidth: number
  targetHeight: number
  /** Composition, subject, lighting, palette, texture, negative space. */
  prompt: string
  /** `low` while iterating on wording, `high` for anything kept. */
  quality?: Quality
  /** Named inspirations, as raw bytes. Treatment reference only. */
  referenceImages?: Buffer[]
  /** A parent plate, when revising and its treatment should carry forward. */
  parentPlate?: Buffer
}

export interface ImageCallRequest {
  width: number
  height: number
  prompt: string
  quality: Quality
  referenceImages: Buffer[]
  parentPlate?: Buffer
}

/** Whatever performs the generation. Returns a raster at exactly the size asked. */
export type ImageCaller = (req: ImageCallRequest) => Promise<Raster>

export interface PlateResult {
  /** Exactly `targetWidth` x `targetHeight`. */
  raster: Raster
  generatedWidth: number
  generatedHeight: number
  scaleX: number
  scaleY: number
  anisotropy: number
  aspectExact: boolean
  quality: Quality
  /** True when the model was asked to edit a parent rather than generate fresh. */
  edited: boolean
}

export class PlateImpossible extends Error {
  constructor(
    readonly targetWidth: number,
    readonly targetHeight: number,
    readonly reasons: string[],
  ) {
    super(
      `${targetWidth}x${targetHeight} cannot be produced by ${GPT_IMAGE_2.name}: ` +
        reasons.join('; '),
    )
    this.name = 'PlateImpossible'
  }
}

/**
 * Never crops, never pads, never stretches beyond the residual anisotropy the
 * envelope forces. Refuses outright rather than degrading silently, because a
 * canvas that cannot be served is a finding for an operator, not a runtime error.
 */
export async function generatePlate(
  request: PlateRequest,
  call: ImageCaller,
  env: Envelope = GPT_IMAGE_2,
): Promise<PlateResult> {
  const { targetWidth, targetHeight } = request
  const plan = planGeneration(targetWidth, targetHeight, env)
  if (!plan.ok) throw new PlateImpossible(targetWidth, targetHeight, plan.reasons)

  const quality = request.quality ?? 'low'
  const generated = await call({
    width: plan.generateWidth,
    height: plan.generateHeight,
    prompt: request.prompt,
    quality,
    referenceImages: request.referenceImages ?? [],
    parentPlate: request.parentPlate,
  })

  if (generated.width !== plan.generateWidth || generated.height !== plan.generateHeight) {
    throw new Error(
      `the image call returned ${generated.width}x${generated.height}, ` +
        `not the ${plan.generateWidth}x${plan.generateHeight} that was requested`,
    )
  }

  const raster = resampleTo(generated, targetWidth, targetHeight)

  if (raster.width !== targetWidth || raster.height !== targetHeight) {
    throw new Error(`resample produced ${raster.width}x${raster.height}`)
  }
  if (!isFullyOpaque(raster)) {
    // gpt-image-2 does not support transparency, so a plate with alpha means
    // something upstream is not the plate we asked for.
    throw new Error('plate is not fully opaque; a plate must be full-bleed')
  }

  return {
    raster,
    generatedWidth: plan.generateWidth,
    generatedHeight: plan.generateHeight,
    scaleX: plan.scaleX,
    scaleY: plan.scaleY,
    anisotropy: plan.anisotropy,
    aspectExact: plan.aspectExact,
    quality,
    edited: request.parentPlate !== undefined,
  }
}

/**
 * What the caller should do about a failure, before it does anything.
 *
 * `needs-human` exists because a real failure taught us it had to. An exhausted
 * credit balance arrives as **HTTP 429**, which every sane retry policy treats as
 * transient — and no amount of backoff refills an account. A run would have
 * retried until it timed out while the agent learned nothing.
 */
export type FailureKind = 'retry' | 'change-the-request' | 'needs-human' | 'unknown'

export interface ImageFailure {
  kind: FailureKind
  code?: string
  moderationStage?: 'input' | 'output' | 'unknown'
  categories?: string[]
  /** Composed for the agent to read and act on, not for a log. */
  hint: string
}

/**
 * Classifies an image failure so the two kinds are never confused.
 *
 * Transient failures retry. A user error must not: the request itself has to
 * change, and retrying it burns money to reach the same refusal. `error.code` is
 * the stable discriminator, so nothing here reads a message string.
 */
export function classifyImageFailure(error: unknown): ImageFailure {
  const e = error as {
    status?: number
    type?: string
    code?: string
    moderation_details?: { moderation_stage?: string; categories?: string[] }
  }

  // Checked before the 429 rule, because this one arrives *as* a 429 and is the
  // opposite of transient.
  if (e?.type === 'insufficient_quota' || e?.code === 'credit_balance_exhausted') {
    return {
      kind: 'needs-human',
      code: e.code,
      hint:
        'the account has no credits left. Retrying cannot fix this and neither can ' +
        'changing the prompt — stop, and report that billing needs attention.',
    }
  }

  if (e?.status === 401) {
    return {
      kind: 'needs-human',
      code: e.code,
      hint:
        'the key was rejected. Either it is invalid or it lacks the model.request ' +
        'scope. Stop; this is a key configuration problem, not a prompt problem.',
    }
  }

  if (e?.status === 403) {
    return {
      kind: 'needs-human',
      code: e.code,
      hint:
        'the request was forbidden — typically an organisation that has not completed ' +
        'verification for this model. Stop and report it.',
    }
  }

  if (e?.status === 429 || (typeof e?.status === 'number' && e.status >= 500)) {
    return {
      kind: 'retry',
      code: e.code,
      hint: `transient failure (HTTP ${e.status}); retry with backoff`,
    }
  }

  if (e?.type === 'image_generation_user_error') {
    if (e.code === 'moderation_blocked') {
      const stage = (e.moderation_details?.moderation_stage ?? 'unknown') as
        | 'input'
        | 'output'
        | 'unknown'
      const categories = e.moderation_details?.categories ?? []
      const where =
        stage === 'input'
          ? 'the prompt or an input image was blocked'
          : stage === 'output'
            ? 'the generated image was blocked after the fact'
            : 'the block could not be attributed to input or output'
      return {
        kind: 'change-the-request',
        code: e.code,
        moderationStage: stage,
        categories,
        hint:
          `${where}${categories.length ? ` (${categories.join(', ')})` : ''}. ` +
          'Revise the prompt — describe the scene in neutral, concrete visual terms ' +
          'and remove anything that reads as targeting a person. Do not retry unchanged.',
      }
    }
    return {
      kind: 'change-the-request',
      code: e.code,
      hint:
        `the request was rejected as a user error (${e.code ?? 'no code'}). ` +
        'Change the prompt or the input images; retrying unchanged will fail identically.',
    }
  }

  return {
    kind: 'unknown',
    code: e?.code,
    hint: 'unrecognised failure; do not retry blindly — surface it and stop',
  }
}
