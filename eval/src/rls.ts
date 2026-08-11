import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

/**
 * Test harness for row-level security.
 *
 * The point of these helpers is to make it easy to assert a *refusal*. A policy
 * that permits the right thing is half a guarantee; the half that matters is
 * that it refuses everything else, and refusals are the awkward thing to test
 * because a passing test looks identical to a test that never ran.
 *
 * So every assertion here runs inside a transaction that is rolled back, against
 * a real connection, with the claims a real run would carry.
 */

/** What identifies a run. Everything else in the token is Supabase's to require. */
export interface RunClaims {
  run_id: string
  revision_id: string
  brand_kit_id: string
}

export interface MintOptions {
  /** The project's JWT signing secret. Backend only — never enters a sandbox. */
  secret: string
  /**
   * The project ref.
   *
   * Not optional, and the reason is worth recording: a token without `ref` is
   * signed correctly and still rejected with a bare 401, which reads exactly
   * like a wrong secret. That cost an hour of chasing the wrong thing.
   */
  projectRef: string
  /**
   * Token lifetime. Defaults to the same 20-minute budget the sandbox timeout
   * and signed URLs use, because a token that expires before the run it
   * authorises is a failure mode with no useful error.
   */
  ttlSeconds?: number
  /** Injectable clock, so the expiry arithmetic is testable. */
  now?: number
}

const RUN_TOKEN_TTL_SECONDS = 20 * 60

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Mints the HS256 token a run connects with.
 *
 * Hand-rolled rather than pulled from a library: it is three base64 segments and
 * an HMAC, and the code proving tenant isolation should not delegate something
 * this small.
 *
 * `role: 'sandbox_run'` names a Postgres role that must exist and be granted to
 * `authenticator`, or PostgREST refuses the token outright. That refusal is a
 * feature — it means an unmigrated database cannot be reached by a run at all.
 */
export function mintRunToken(claims: RunClaims, options: MintOptions): string {
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1000)
  const payload = {
    iss: 'supabase',
    ref: options.projectRef,
    role: 'sandbox_run',
    run_id: claims.run_id,
    revision_id: claims.revision_id,
    brand_kit_id: claims.brand_kit_id,
    iat: issuedAt,
    exp: issuedAt + (options.ttlSeconds ?? RUN_TOKEN_TTL_SECONDS),
  }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const signature = b64url(createHmac('sha256', options.secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${signature}`
}

/** Reads a token's payload without verifying it. For assertions and logs only. */
export function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

export interface ConnectedDb {
  client: Client
  end: () => Promise<void>
}

export interface ConnectOptions {
  /**
   * PEM for the server's CA, when the system trust store does not carry it.
   *
   * Supabase publishes one under Settings → Database → SSL configuration. Point
   * `SUPABASE_CA_CERT` at the downloaded file rather than turning verification
   * off: an unverified connection to a database holding tenant data is exactly
   * the leak this suite exists to disprove.
   */
  caCertPath?: string
}

/**
 * Splits a Postgres URI into fields, taking the password literally.
 *
 * `new URL()` cannot do this: a `#` in a password starts a fragment, so the
 * string parses as a different connection or not at all. `psql` accepts the same
 * string happily, which makes the failure look like a code problem rather than a
 * quoting one.
 *
 * Splitting on the *last* `@` and the *first* `:` of the credentials keeps both
 * `#` and `@` usable in a password, so nobody has to percent-encode a secret by
 * hand to run the tests.
 */
export function parseConnectionString(uri: string) {
  const withoutScheme = uri.trim().replace(/^postgres(?:ql)?:\/\//, '')
  const at = withoutScheme.lastIndexOf('@')
  if (at === -1) throw new Error('connection string has no credentials')

  const credentials = withoutScheme.slice(0, at)
  const colon = credentials.indexOf(':')
  const user = colon === -1 ? credentials : credentials.slice(0, colon)
  const password = colon === -1 ? undefined : credentials.slice(colon + 1)

  const rest = withoutScheme.slice(at + 1)
  const match = /^([^:/?]+)(?::(\d+))?\/([^?]+)/.exec(rest)
  if (!match) throw new Error('connection string has no host and database')

  return {
    user,
    password,
    host: match[1],
    port: match[2] ? Number(match[2]) : 5432,
    database: match[3],
  }
}

export async function connect(
  connectionString: string,
  options: ConnectOptions = {},
): Promise<ConnectedDb> {
  const fields = parseConnectionString(connectionString)
  const local = /^(localhost|127\.0\.0\.1)$/.test(fields.host)
  const ca = options.caCertPath ?? process.env.SUPABASE_CA_CERT
  const client = new Client({
    ...fields,
    // Verified TLS everywhere but a local socket. Never `rejectUnauthorized:
    // false` — a test that trusts any certificate cannot claim to have proven
    // isolation.
    ssl: local ? undefined : ca ? { ca: readFileSync(ca, 'utf8') } : true,
  })
  await client.connect()
  return { client, end: () => client.end() }
}

/**
 * Runs `body` as a sandbox run, then rolls everything back.
 *
 * `set local` and `set_config(..., true)` are both transaction-scoped, so the
 * claims and the role cannot leak into another test even if the body throws.
 */
export async function asRun<T>(
  client: Client,
  // Deliberately loose. These tests must be able to send a token that is missing
  // a claim, carries the wrong role, or has no claims at all — a type that only
  // permitted well-formed runs would make the most important cases unwritable.
  claims: Record<string, unknown>,
  body: (c: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin')
  try {
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ])
    await client.query('set local role sandbox_run')
    return await body(client)
  } finally {
    await client.query('rollback')
  }
}

/**
 * Runs `body` as a deployment, then rolls everything back.
 *
 * A separate helper rather than a role parameter on `asRun`, so a test cannot
 * accidentally assert a generation guarantee while connected as a deploy box.
 */
export async function asDeploy<T>(
  client: Client,
  claims: Record<string, unknown>,
  body: (c: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin')
  try {
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ])
    await client.query('set local role sandbox_deploy')
    return await body(client)
  } finally {
    await client.query('rollback')
  }
}

/**
 * Runs `body` as a signed-in person, then rolls everything back.
 *
 * A third helper rather than a role argument, for the same reason as `asDeploy`: a
 * test that can silently connect as the wrong role can assert the wrong guarantee
 * and still pass.
 */
export async function asAppUser<T>(
  client: Client,
  claims: Record<string, unknown>,
  body: (c: Client) => Promise<T>,
): Promise<T> {
  await client.query('begin')
  try {
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ])
    await client.query('set local role app_user')
    return await body(client)
  } finally {
    await client.query('rollback')
  }
}

/** Seeds inside a transaction as the privileged connection, then rolls back. */
export async function inRollback<T>(client: Client, body: (c: Client) => Promise<T>): Promise<T> {
  await client.query('begin')
  try {
    return await body(client)
  } finally {
    await client.query('rollback')
  }
}

export interface Denial {
  denied: boolean
  code?: string
  message?: string
}

/**
 * Attempts a statement and reports whether the database refused it.
 *
 * Distinguishes the two shapes a refusal takes, because they are not the same
 * thing and conflating them hides bugs:
 *
 *   - an error (`42501 insufficient_privilege`, or an RLS check violation) means
 *     the write was rejected outright;
 *   - zero rows affected means the policy filtered the target away, so the
 *     statement succeeded against nothing.
 *
 * Both are denials. A test that only looked for a thrown error would pass while
 * an UPDATE silently matched no rows for the wrong reason.
 */
export async function attempt(client: Client, sql: string, params: unknown[] = []): Promise<Denial> {
  try {
    const result = await client.query(sql, params)
    if ((result.rowCount ?? 0) === 0) {
      return { denied: true, code: 'no-rows', message: 'statement affected no rows' }
    }
    return { denied: false }
  } catch (error) {
    const e = error as { code?: string; message?: string }
    return { denied: true, code: e.code, message: e.message }
  }
}

/** A fresh uuid without a dependency, for fixture ids. */
export const uuid = () => crypto.randomUUID()

/** Reads whether RLS is on for every table in `public`. */
export async function rlsReport(client: Client) {
  const { rows } = await client.query<{
    table_name: string
    rls_enabled: boolean
    policy_count: string
  }>('select * from app.assert_rls_everywhere()')
  return rows.map((r) => ({
    table: r.table_name,
    enabled: r.rls_enabled,
    policies: Number(r.policy_count),
  }))
}
