import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { connect, decodePayload, mintRunToken, uuid } from '../src/rls'

/**
 * Storage isolation, exercised through the real HTTP API.
 *
 * The table tests reach Postgres directly and set the claims themselves, which
 * proves the policies but skips everything in front of them. A sandbox does not
 * have a Postgres connection — it has a bearer token and a URL. So these tests go
 * the whole way round: mint the token the backend would mint, and try to put
 * bytes where the run should not be able to.
 *
 * That round trip is also the only way to catch a class of mistake the direct
 * tests cannot see: a policy that is correct in SQL and never consulted, because
 * the gateway rejected or rewrote the request first.
 */

const DB_URL = process.env.SUPABASE_DB_URL
const API_URL = process.env.SUPABASE_URL
const ANON = process.env.SUPABASE_ANON_KEY
const SECRET = process.env.SUPABASE_JWT_SECRET

const ready = Boolean(DB_URL && API_URL && ANON && SECRET)
const describeApi = ready ? describe : describe.skip

if (!ready) {
  const missing = [
    !DB_URL && 'SUPABASE_DB_URL',
    !API_URL && 'SUPABASE_URL',
    !ANON && 'SUPABASE_ANON_KEY',
    !SECRET && 'SUPABASE_JWT_SECRET',
  ].filter(Boolean)
  // eslint-disable-next-line no-console
  console.warn(
    `\n  storage-rls.test.ts SKIPPED — missing ${missing.join(', ')}.\n` +
      '  Storage isolation has NOT been verified by this run.\n',
  )
}

describeApi('storage isolation over HTTP', () => {
  let client: Client
  let end: () => Promise<void>
  let projectRef: string

  const kitA = `kit-a-${Date.now()}`
  const kitB = `kit-b-${Date.now()}`
  const reqA = uuid()
  const reqB = uuid()
  const revA = uuid()
  const revB = uuid()
  const runA = uuid()
  const runB = uuid()

  let tokenA = ''
  let prefixA = ''
  let prefixB = ''

  /** PUT some bytes and report the status, without throwing on a refusal. */
  const upload = async (path: string, token: string) => {
    const response = await fetch(`${API_URL}/storage/v1/object/${path}`, {
      method: 'POST',
      headers: {
        apikey: ANON as string,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array([1, 2, 3, 4]),
    })
    return { status: response.status, body: (await response.text()).slice(0, 200) }
  }

  const download = async (path: string, token: string) => {
    const response = await fetch(`${API_URL}/storage/v1/object/${path}`, {
      headers: { apikey: ANON as string, Authorization: `Bearer ${token}` },
    })
    return response.status
  }

  beforeAll(async () => {
    const c = await connect(DB_URL as string)
    client = c.client
    end = c.end

    // The ref lives inside the anon key, so it never has to be configured twice
    // and cannot drift from the project the keys belong to.
    projectRef = decodePayload(ANON as string).ref as string

    await client.query(
      `insert into brand_kits (id, customer_id, display_name, ingest_status)
       values ($1,'c1','Kit A','ready'), ($2,'c2','Kit B','ready')`,
      [kitA, kitB],
    )
    await client.query(
      `insert into requests (id, kit_id, kind, campaign_name)
       values ($1,$3,'new','A'), ($2,$4,'new','B')`,
      [reqA, reqB, kitA, kitB],
    )
    await client.query(`insert into revisions (id, request_id, n) values ($1,$3,1), ($2,$4,1)`, [
      revA,
      revB,
      reqA,
      reqB,
    ])
    await client.query(
      `insert into runs (id, revision_id, sandbox_provider) values ($1,$3,'e2b'), ($2,$4,'e2b')`,
      [runA, runB, revA, revB],
    )

    tokenA = mintRunToken(
      { run_id: runA, revision_id: revA, brand_kit_id: kitA },
      { secret: SECRET as string, projectRef },
    )
    prefixA = `${reqA}/rev-1`
    prefixB = `${reqB}/rev-1`
  })

  afterAll(async () => {
    if (!client) return
    await client.query('delete from requests where kit_id = any($1)', [[kitA, kitB]])
    await client.query('delete from brand_kits where id = any($1)', [[kitA, kitB]])
    await end()
  })

  it('mints a token carrying every claim Supabase requires', () => {
    const payload = decodePayload(tokenA)
    // `ref` is the one that is easy to omit and impossible to diagnose: without
    // it the token is signed correctly and still rejected with a bare 401.
    expect(payload.ref).toBe(projectRef)
    expect(payload.iss).toBe('supabase')
    expect(payload.role).toBe('sandbox_run')
    expect(payload.exp as number).toBeGreaterThan(payload.iat as number)
  })

  it('can write under its own revision prefix', async () => {
    const result = await upload(`work/${prefixA}/renders/square.png`, tokenA)
    expect(result.status, result.body).toBeLessThan(300)
  })

  it('can read back what it wrote', async () => {
    await upload(`work/${prefixA}/renders/readback.png`, tokenA)
    expect(await download(`work/${prefixA}/renders/readback.png`, tokenA)).toBeLessThan(300)
  })

  it("cannot write under another revision's prefix", async () => {
    const result = await upload(`work/${prefixB}/renders/square.png`, tokenA)
    expect(result.status, `expected a refusal, got ${result.status}: ${result.body}`)
      .toBeGreaterThanOrEqual(400)
  })

  it('cannot write to the bucket root, outside any revision', async () => {
    const result = await upload(`work/loose.png`, tokenA)
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it('cannot write into the brains bucket at all', async () => {
    // brains is read-only to a run: assets are staged by ingest, never by a box.
    const result = await upload(`brains/${kitA}/forged-logo.svg`, tokenA)
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it('cannot read another revision’s object', async () => {
    // Written privileged, so the object genuinely exists and the refusal is the
    // policy rather than a 404 for missing bytes.
    const tokenB = mintRunToken(
      { run_id: runB, revision_id: revB, brand_kit_id: kitB },
      { secret: SECRET as string, projectRef },
    )
    await upload(`work/${prefixB}/renders/b-only.png`, tokenB)
    expect(await download(`work/${prefixB}/renders/b-only.png`, tokenA)).toBeGreaterThanOrEqual(400)
  })

  it('cannot overwrite an object by upsert', async () => {
    const path = `work/${prefixA}/renders/once.png`
    await upload(path, tokenA)
    const again = await fetch(`${API_URL}/storage/v1/object/${path}`, {
      method: 'POST',
      headers: {
        apikey: ANON as string,
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/octet-stream',
        // An upsert needs UPDATE on storage.objects, which this role does not have.
        // Asserted because a save path that quietly used upsert would look correct
        // and silently break append-only — which is how it was found.
        'x-upsert': 'true',
      },
      body: new Uint8Array([9, 9, 9]),
    })
    expect(again.status).toBeGreaterThanOrEqual(400)
  })

  it('cannot delete what it has written', async () => {
    const path = `work/${prefixA}/renders/keep.png`
    await upload(path, tokenA)
    const response = await fetch(`${API_URL}/storage/v1/object/${path}`, {
      method: 'DELETE',
      headers: { apikey: ANON as string, Authorization: `Bearer ${tokenA}` },
    })
    // Append-only from inside a box: a run cannot destroy evidence of itself.
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('is refused once the token has expired', async () => {
    const stale = mintRunToken(
      { run_id: runA, revision_id: revA, brand_kit_id: kitA },
      { secret: SECRET as string, projectRef, ttlSeconds: -60 },
    )
    const result = await upload(`work/${prefixA}/renders/stale.png`, stale)
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it('is refused when signed with the wrong secret', async () => {
    const forged = mintRunToken(
      { run_id: runA, revision_id: revA, brand_kit_id: kitA },
      { secret: 'not-the-signing-secret', projectRef },
    )
    const result = await upload(`work/${prefixA}/renders/forged.png`, forged)
    expect(result.status).toBeGreaterThanOrEqual(400)
  })
})
