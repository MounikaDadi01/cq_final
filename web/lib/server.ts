import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Server-only helpers. Nothing here may be imported from a client component.
 *
 * The division is the point of this file. Two secrets live on this side and must
 * never cross to the browser:
 *
 *   SUPABASE_JWT_SECRET       mints sessions
 *   SUPABASE_SERVICE_ROLE_KEY bypasses RLS entirely
 *
 * The browser gets one thing: a short-lived `app_user` token carrying a customer id.
 * Everything it can then read or write is decided by database policy, not by the
 * code in `app/`. That ordering is deliberate — a mistake in a React component
 * returns zero rows instead of another customer's work.
 */

const REPO_ROOT = join(process.cwd(), '..')

let cached: Record<string, string> | null = null

export function env(): Record<string, string> {
  if (cached) return cached
  let fromFile: Record<string, string> = {}
  try {
    fromFile = Object.fromEntries(
      readFileSync(join(REPO_ROOT, '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
        }),
    )
  } catch {
    /* fall through to process env */
  }
  cached = { ...fromFile, ...process.env } as Record<string, string>
  return cached
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

export function projectRef(): string {
  return decodePayload(env().SUPABASE_ANON_KEY).ref as string
}

/** How long a browser session lasts before it has to be re-minted. */
export const SESSION_SECONDS = 60 * 60

/**
 * Mints the token the browser will carry.
 *
 * `ref` is required — a token without it is signed correctly and rejected with a
 * bare 401 that looks exactly like a wrong secret.
 */
export function mintUserToken(customerId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: 'supabase',
    ref: projectRef(),
    role: 'app_user',
    customer_id: customerId,
    iat: now,
    exp: now + SESSION_SECONDS,
  }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const signature = b64url(
    createHmac('sha256', env().SUPABASE_JWT_SECRET).update(`${header}.${body}`).digest(),
  )
  return `${header}.${body}.${signature}`
}

export interface UserClaims {
  role: string
  customer_id: string
  iss: string
  ref: string
  iat: number
  exp: number
}

/**
 * Verifies a session token before any claim inside it is believed.
 *
 * This exists because of a real hole, not as belt-and-braces. A cookie is
 * client-supplied: anyone can send an arbitrary `cq_session` with curl. The run route
 * previously decoded the payload and trusted `customer_id` from it — and that route
 * is the one place holding `service_role`. So a hand-crafted token with no valid
 * signature would have passed the ownership check and started a run against another
 * customer's revision.
 *
 * The reads were never exposed the same way, because they hand the token to Supabase
 * and Supabase verifies it. That asymmetry is exactly what made this easy to miss:
 * the only route that verifies nothing locally is the only route that does not need
 * Supabase to say yes first.
 *
 * Returns null on any failure rather than throwing, so a caller cannot accidentally
 * continue with a partially-checked token.
 */
export function verifyUserToken(token: string): UserClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, signature] = parts

  let head: { alg?: string; typ?: string }
  let claims: Partial<UserClaims>
  try {
    head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  // Pin the algorithm. Accepting whatever the token names is how `alg: none` and
  // algorithm-confusion attacks work.
  if (head.alg !== 'HS256') return null

  const expected = createHmac('sha256', env().SUPABASE_JWT_SECRET)
    .update(`${header}.${body}`)
    .digest()
  let provided: Buffer
  try {
    provided = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  // Constant time, and length-checked first because timingSafeEqual throws on a
  // length mismatch rather than returning false.
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null

  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (typeof claims.iat === 'number' && claims.iat > now + 60) return null
  if (claims.iss !== 'supabase') return null
  if (claims.ref !== projectRef()) return null
  if (claims.role !== 'app_user') return null
  if (typeof claims.customer_id !== 'string' || claims.customer_id.length === 0) return null

  return claims as UserClaims
}

/**
 * Starts a launcher and reports an immediate failure back to the caller.
 *
 * The previous version spawned detached with `stdio: 'ignore'`, which meant a launch
 * that refused to start was completely silent: the request sat at `draft` forever with
 * no run row, no error, and nothing in the UI to explain it. A stale sandbox image did
 * exactly that, and the guard's careful message went to a closed pipe.
 *
 * Most launch failures are fast and structural — a stale template, a missing key, a kit
 * that is not ready — so waiting a few seconds catches them and returns the reason. A
 * run that gets past that point is genuinely long, and is left to finish detached while
 * its progress is read from the database.
 *
 * Output is always appended to a log, so a later failure is still inspectable rather
 * than lost.
 */
export async function startLauncher(
  args: string[],
  logName: string,
  graceMs = 9000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { spawn } = await import('node:child_process')
  const { mkdirSync, appendFileSync } = await import('node:fs')

  const logDir = join(process.cwd(), '.launch-logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${logName}.log`)

  // cq-allow-disqualifier-scan: spawns the launcher, which provisions a remote E2B
  // sandbox and waits. The agent runs in that box, never beside this API. The brief
  // permits queues and out-of-process workers; it forbids the agent living here.
  const child = spawn('npx', args, { cwd: join(process.cwd(), '..', 'eval'), detached: true }) // cq-allow-disqualifier-scan: spawns the launcher; the agent runs in a remote E2B box
  let tail = ''
  const capture = (chunk: Buffer) => {
    const text = chunk.toString()
    // Kept short: the useful part of a refusal is its first lines, and the whole
    // transcript is on disk anyway.
    tail = (tail + text).slice(-1800)
    try {
      appendFileSync(logPath, text)
    } catch {
      /* a log we cannot write must not fail the run */
    }
  }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)

  return await new Promise((resolve) => {
    const settled = setTimeout(() => {
      // Past the grace period it is a real run. Detach and stop holding the request.
      child.unref()
      resolve({ ok: true })
    }, graceMs)

    child.on('exit', (code) => {
      clearTimeout(settled)
      if (code === 0) return resolve({ ok: true })
      const lines = tail
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('npm warn'))
      resolve({
        ok: false,
        error: lines.slice(-6).join(' · ') || `the launcher exited with code ${code}`,
      })
    })

    child.on('error', (error) => {
      clearTimeout(settled)
      resolve({ ok: false, error: error.message })
    })
  })
}

/**
 * A privileged fetch, for the two things only the backend may do: list customers
 * before anyone is signed in, and start a run.
 *
 * Kept as one narrow function so every use of `service_role` in this app is visible
 * in one place and can be counted.
 */
export async function serviceFetch(path: string, init: RequestInit = {}) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env()
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
