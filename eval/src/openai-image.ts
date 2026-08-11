import { existsSync, readFileSync } from 'node:fs'
import { decodePng } from './png'
import type { ImageCallRequest, ImageCaller } from './plate'

/**
 * The live image call: `/v1/images/generations` with the model pinned.
 *
 * Pinned deliberately. The Responses API image tool selects a GPT Image model on
 * your behalf, and every size decision we make is computed against gpt-image-2's
 * envelope specifically — a different model would accept different sizes and the
 * plates would stop being exact-dimension.
 */
export interface OpenAIImageOptions {
  apiKey: string
  model?: string
  /** Generous by default: a complex prompt can take up to two minutes. */
  timeoutMs?: number
}

export function createOpenAIImageCaller(options: OpenAIImageOptions): ImageCaller {
  const model = options.model ?? 'gpt-image-2'
  const timeoutMs = options.timeoutMs ?? 180_000

  return async (req: ImageCallRequest) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // Reference imagery has to go through /images/edits — /images/generations
    // takes no image input at all, which is why attaching an inspiration was
    // impossible until this branch existed. The size envelope is identical on
    // both endpoints, so the planner's arithmetic still holds.
    const references = [...(req.parentPlate ? [req.parentPlate] : []), ...req.referenceImages]
    const useEdits = references.length > 0

    try {
      let response: Response
      if (useEdits) {
        const form = new FormData()
        form.append('model', model)
        form.append('prompt', req.prompt)
        form.append('size', `${req.width}x${req.height}`)
        form.append('quality', req.quality)
        form.append('n', '1')
        // Repeated `image[]`, in order. The first entry is the one a mask would
        // apply to, so a parent plate leads when revising.
        references.forEach((bytes, i) => {
          const copy = new Uint8Array(bytes.byteLength)
          copy.set(bytes)
          form.append('image[]', new Blob([copy], { type: 'image/png' }), `reference-${i}.png`)
        })
        response = await fetch('https://api.openai.com/v1/images/edits', {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${options.apiKey}` },
          body: form,
        })
      } else {
        response = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            prompt: req.prompt,
            // The exact legal size the planner chose. Never `auto`: the whole
            // compliance argument depends on knowing what came back.
            size: `${req.width}x${req.height}`,
            quality: req.quality,
            n: 1,
          }),
        })
      }

      const text = await response.text()

      if (!response.ok) {
        let parsed: { error?: Record<string, unknown> } = {}
        try {
          parsed = JSON.parse(text)
        } catch {
          /* a non-JSON body is still a failure worth surfacing verbatim */
        }
        // Shaped so classifyImageFailure can read it without guessing.
        throw Object.assign(new Error(text.slice(0, 500)), {
          status: response.status,
          requestId: response.headers.get('x-request-id') ?? undefined,
          ...(parsed.error ?? {}),
        })
      }

      const body = JSON.parse(text) as { data?: { b64_json?: string }[] }
      const b64 = body.data?.[0]?.b64_json
      if (!b64) throw new Error('the response carried no image data')

      return decodePng(Buffer.from(b64, 'base64'))
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Reads `.env` without a dependency, so a preflight needs no install step. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}
