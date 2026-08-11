/**
 * The run's own account of what it did, made durable while it is still running.
 *
 * Why this exists: a box is deleted the moment the run ends, and an unannounced kill
 * gives it no chance to write anything. A transcript assembled in memory and saved at
 * the end is therefore exactly the transcript you do not have when you need it — the
 * runs worth reading are the ones that died. So this flushes on a timer, and what has
 * already been flushed is already durable.
 *
 * Segments, not one growing file. `save_work` is append-only by design: a path it has
 * already stored comes back 409 and is skipped, which is what stops a box rewriting its
 * own history. A single `transcript.jsonl` re-saved every thirty seconds would therefore
 * persist its first thirty seconds and silently discard the rest. Numbered segments
 * (`transcript/<run>-000.jsonl`, `-001.jsonl`, …) each get saved exactly once, and
 * reading them in filename order reconstructs the run.
 *
 * Role: the segments land as `result`, decided by `roleOf` in save_work.mjs. Deliberate,
 * not incidental — the deploy role may only insert `recording` and `result`
 * (0016_deploy_fields_and_result.sql), so any other role would be refused by policy on
 * the deploy box. `result` is also what these are: the box's own account of its work.
 *
 * Not a substitute for findings. A finding is a claim a person should act on; this is
 * evidence for whoever is debugging. Nothing here is read back by the product.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Values that must never reach a line, matched by key rather than by content. */
const SECRET_KEY = /pass|secret|token|key|credential|authorization/i

/**
 * Signed URLs carry their own credential in the query string, so the query goes.
 * Keeping the path is the point — knowing *which* artifact was fetched is most of the
 * value of the line.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '…'
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      try {
        const url = new URL(value)
        return url.search ? `${url.origin}${url.pathname}?…` : value
      } catch {
        return value
      }
    }
    return value.length > 400 ? `${value.slice(0, 400)}…` : value
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrub(inner, depth + 1)
    }
    return out
  }
  return value
}

export interface TranscriptOptions {
  /** Where the tree that `save_work` saves lives. */
  workDir: string
  runId: string
  /** How often to make what has happened durable. */
  flushMs?: number
}

export class Transcript {
  private buffer: string[] = []
  private segment = 0
  private timer: NodeJS.Timeout | null = null
  private readonly dir: string

  constructor(private readonly options: TranscriptOptions) {
    this.dir = join(options.workDir, 'transcript')
    mkdirSync(this.dir, { recursive: true })
  }

  /**
   * Record one event. Never throws: a transcript that can break the run it is
   * describing is worse than no transcript, and this is the one component whose failure
   * must not cost a render that has already been paid for.
   */
  line(event: string, detail: Record<string, unknown> = {}): void {
    try {
      this.buffer.push(
        JSON.stringify({
          at: new Date().toISOString(),
          run: this.options.runId,
          event,
          ...(scrub(detail) as Record<string, unknown>),
        }),
      )
    } catch {
      // A value that will not serialise is not worth ending a run over.
    }
  }

  /** Begin flushing on a timer. Unreferenced, so it cannot hold the process open. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.options.flushMs ?? 30_000)
    this.timer.unref?.()
  }

  /**
   * Write what has accumulated and hand it to `save_work`.
   *
   * `--only transcript/` deliberately narrows this to the segments. A bare `save_work`
   * would also sweep up anything else new in the tree, and a PNG caught half-written
   * would be stored and filed as a finished `render` — append-only, so unfixable. The
   * debugging tool must not be able to publish a corrupt ad.
   *
   * Making renders durable as they appear is worth doing, and it is a different change
   * with its own failure modes. It does not get to ride in on this one.
   */
  flush(): void {
    if (this.buffer.length === 0) return
    const lines = this.buffer
    this.buffer = []
    const name = `${this.options.runId}-${String(this.segment).padStart(3, '0')}.jsonl`
    this.segment += 1
    try {
      writeFileSync(join(this.dir, name), `${lines.join('\n')}\n`)
      execFileSync('save_work', ['--only', 'transcript'], {
        encoding: 'utf8',
        timeout: 120_000,
        stdio: 'ignore',
      })
    } catch (error) {
      // Reported to the log, which the launcher streams, and then dropped. A box that
      // cannot save its transcript can still finish its work and save that.
      console.error(`[transcript] segment ${name} not saved: ${(error as Error).message}`)
    }
  }

  /** Final flush. Call before the box's own last `save_work --final`. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flush()
  }
}
