import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { asDeploy, asRun, attempt, connect, decodePayload, mintRunToken, rlsReport, uuid } from '../src/rls'

/**
 * Isolation, asserted against a real database.
 *
 * These tests are written the awkward way round on purpose: almost every one
 * asserts that something is **refused**. A policy that permits the right thing
 * proves very little — the guarantee is that it refuses everything else, and a
 * refusal is the case that quietly stops being tested when a policy is relaxed.
 *
 * Two fixture kits exist in every test, and neither is named after a real
 * customer. The cross-tenant case is reproduced structurally: an asset owned by
 * one kit, filed under another. That is the packet's planted bug expressed as
 * data, so the test keeps working for any brand.
 *
 * Skipped without `SUPABASE_DB_URL`. Skipped, not passed — a suite that goes
 * green because it never connected is the failure mode this whole layer exists
 * to prevent.
 */

const DB_URL = process.env.SUPABASE_DB_URL
const describeDb = DB_URL ? describe : describe.skip

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n  rls.test.ts SKIPPED — no SUPABASE_DB_URL.\n' +
      '  Nothing about isolation has been verified by this run.\n',
  )
}

describeDb('row-level security', () => {
  let client: Client
  let end: () => Promise<void>

  // Two kits, two requests, two revisions, two runs. Everything below asks
  // whether A can reach B.
  const kitA = `kit-a-${Date.now()}`
  const kitB = `kit-b-${Date.now()}`
  const reqA = uuid()
  const reqB = uuid()
  const revA = uuid()
  const revB = uuid()
  const runA = uuid()
  const runB = uuid()

  const claimsA = {
    role: 'sandbox_run' as const,
    run_id: runA,
    revision_id: revA,
    brand_kit_id: kitA,
  }

  // Same run, same revision — only the role differs, so any difference in what
  // is reachable is attributable to the role and nothing else.
  const deployClaimsA = { ...claimsA, role: 'sandbox_deploy' as const }

  beforeAll(async () => {
    const c = await connect(DB_URL as string)
    client = c.client
    end = c.end

    await client.query('begin')
    await client.query(
      `insert into brand_kits (id, customer_id, display_name, ingest_status)
       values ($1,'cust-1','Kit A','ready'), ($2,'cust-2','Kit B','ready')`,
      [kitA, kitB],
    )
    // The planted shape: owned by A, sitting in B's folder. Policies read
    // kit_id, so this row belongs to A no matter where it was found.
    await client.query(
      `insert into brand_assets (kit_id, found_in_kit_id, kind, manifest_path, available)
       values ($1, $2, 'logo_reverse', 'brand/misfiled-reverse.svg', true),
              ($1, $1, 'logo',         'brand/a-logo.svg',           true),
              ($2, $2, 'logo',         'brand/b-logo.svg',           true)`,
      [kitA, kitB],
    )
    await client.query(
      `insert into requests (id, kit_id, kind, campaign_name)
       values ($1,$3,'new','A campaign'), ($2,$4,'new','B campaign')`,
      [reqA, reqB, kitA, kitB],
    )
    await client.query(
      `insert into revisions (id, request_id, n) values ($1,$3,1), ($2,$4,1)`,
      [revA, revB, reqA, reqB],
    )
    await client.query(
      `insert into runs (id, revision_id, sandbox_provider) values ($1,$3,'e2b'), ($2,$4,'e2b')`,
      [runA, runB, revA, revB],
    )
    // Committed so the run-role transactions below see them, then removed in
    // afterAll. Fixtures are cleaned up rather than left as debris.
    await client.query('commit')
  })

  afterAll(async () => {
    if (!client) return
    // Requests first. `requests.kit_id` is `on delete restrict` on purpose — a
    // kit with work attached must not vanish underneath it — so the teardown has
    // to unwind in the same order the schema insists on. Revisions, runs and
    // artifacts cascade from requests; assets and fonts cascade from the kit.
    await client.query('delete from requests where kit_id = any($1)', [[kitA, kitB]])
    await client.query('delete from brand_kits where id = any($1)', [[kitA, kitB]])
    await end()
  })

  // -------------------------------------------------------------------------
  // The schema's own guarantee
  // -------------------------------------------------------------------------

  it('has RLS enabled on every table in public', async () => {
    const report = await rlsReport(client)
    const off = report.filter((r) => !r.enabled)
    expect(off, `RLS is off on: ${off.map((r) => r.table).join(', ')}`).toEqual([])
    // Guards against the report itself being empty, which would pass vacuously.
    expect(report.length).toBeGreaterThanOrEqual(10)
  })

  it('raises rather than reporting when RLS is off somewhere', async () => {
    await expect(client.query('select app.require_rls_everywhere()')).resolves.toBeTruthy()
  })

  it('has no table with RLS on and no policy at all', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      'select * from app.tables_without_policies()',
    )
    // Locked and forgotten look identical from outside, so this is surfaced
    // rather than tolerated.
    expect(rows.map((r) => r.table_name)).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Cross-tenant: the planted leak
  // -------------------------------------------------------------------------

  it("cannot see an asset owned by another kit, even one filed in its own folder", async () => {
    const claimsB = { ...claimsA, run_id: runB, revision_id: revB, brand_kit_id: kitB }
    const rows = await asRun(client, claimsB, async (c) => {
      const r = await c.query('select manifest_path from brand_assets')
      return r.rows.map((x) => x.manifest_path)
    })
    // B's run sees only B's own asset. The misfiled one is owned by A and is
    // absent from the result set — not filtered afterwards, never selected.
    expect(rows).toEqual(['brand/b-logo.svg'])
    expect(rows).not.toContain('brand/misfiled-reverse.svg')
  })

  it('does see its own asset that was filed in the wrong folder', async () => {
    const rows = await asRun(client, claimsA, async (c) => {
      const r = await c.query('select manifest_path from brand_assets order by manifest_path')
      return r.rows.map((x) => x.manifest_path)
    })
    // The other half of the same rule: ownership follows kit_id, so A can reach
    // its own asset wherever it sits. Asserted so a fix for the leak cannot
    // quietly hide A's assets too.
    expect(rows).toEqual(['brand/a-logo.svg', 'brand/misfiled-reverse.svg'])
  })

  it('cannot see another kit at all', async () => {
    const rows = await asRun(client, claimsA, async (c) => {
      const r = await c.query('select id from brand_kits')
      return r.rows.map((x) => x.id)
    })
    expect(rows).toEqual([kitA])
  })

  // -------------------------------------------------------------------------
  // Cross-revision: a run is pinned to the one revision it was minted for
  // -------------------------------------------------------------------------

  it('cannot insert an artifact for another revision', async () => {
    const denial = await asRun(client, claimsA, (c) =>
      attempt(
        c,
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1, 'renders/square.png', 'k', 'render')`,
        [revB],
      ),
    )
    expect(denial.denied).toBe(true)
  })

  it('can insert an artifact for its own revision', async () => {
    const denial = await asRun(client, claimsA, (c) =>
      attempt(
        c,
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1, 'renders/square.png', 'k', 'render')`,
        [revA],
      ),
    )
    // The positive case, so a policy that denies everything cannot pass the suite.
    expect(denial.denied).toBe(false)
  })

  it('cannot read another revision', async () => {
    const rows = await asRun(client, claimsA, async (c) => {
      const r = await c.query('select id from revisions')
      return r.rows.map((x) => x.id)
    })
    expect(rows).toEqual([revA])
  })

  it("cannot update another run's row", async () => {
    const denial = await asRun(client, claimsA, (c) =>
      attempt(c, `update runs set status = 'completed' where id = $1`, [runB]),
    )
    expect(denial.denied).toBe(true)
  })

  it('cannot read another revision’s messages', async () => {
    await client.query(
      `insert into messages (revision_id, role, body) values ($1,'user','B only')`,
      [revB],
    )
    const rows = await asRun(client, claimsA, async (c) => {
      const r = await c.query('select body from messages')
      return r.rows.map((x) => x.body)
    })
    expect(rows).not.toContain('B only')
    await client.query('delete from messages where revision_id = $1', [revB])
  })

  // -------------------------------------------------------------------------
  // Append-only: a box cannot erase evidence of itself
  // -------------------------------------------------------------------------

  it('cannot update an artifact it just wrote', async () => {
    const denial = await asRun(client, claimsA, async (c) => {
      await c.query(
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1, 'renders/a.png', 'k', 'render')`,
        [revA],
      )
      return attempt(c, `update artifacts set storage_key = 'x' where revision_id = $1`, [revA])
    })
    expect(denial.denied).toBe(true)
  })

  it('cannot delete an artifact', async () => {
    const denial = await asRun(client, claimsA, async (c) => {
      await c.query(
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1, 'renders/b.png', 'k', 'render')`,
        [revA],
      )
      return attempt(c, 'delete from artifacts where revision_id = $1', [revA])
    })
    expect(denial.denied).toBe(true)
  })

  it('cannot stage a brand asset', async () => {
    const denial = await asRun(client, claimsA, (c) =>
      attempt(
        c,
        `insert into brand_assets (kit_id, found_in_kit_id, kind, manifest_path, available)
         values ($1,$1,'logo','brand/forged.svg',true)`,
        [kitA],
      ),
    )
    expect(denial.denied).toBe(true)
  })

  // -------------------------------------------------------------------------
  // The two sandboxes cannot do each other's job
  //
  // Asserted in both directions. One direction alone would leave the separation
  // resting on whichever code path happens to create the box, which holds only
  // until someone adds a second caller.
  // -------------------------------------------------------------------------

  it('generation cannot write a deploy recording', async () => {
    const denial = await asRun(client, claimsA, (c) =>
      attempt(
        c,
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1, 'deploy/session.webm', 'k', 'recording')`,
        [revA],
      ),
    )
    // A recording is the evidence a deploy happened. If generation could forge
    // one, the artifact role would stop being evidence of anything.
    expect(denial.denied).toBe(true)
  })

  it('deployment cannot write a render', async () => {
    const denial = await asDeploy(client, deployClaimsA, (c) =>
      attempt(
        c,
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1, 'renders/square.png', 'k', 'render')`,
        [revA],
      ),
    )
    expect(denial.denied).toBe(true)
  })

  it('deployment can write a recording for its own revision', async () => {
    const denial = await asDeploy(client, deployClaimsA, (c) =>
      attempt(
        c,
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1, 'deploy/session.webm', 'k', 'recording')`,
        [revA],
      ),
    )
    expect(denial.denied).toBe(false)
  })

  it('deployment can read the artifacts it is publishing', async () => {
    await client.query(
      `insert into artifacts (revision_id, relative_path, storage_key, role)
       values ($1, 'renders/for-deploy.png', 'k', 'render')`,
      [revA],
    )
    const rows = await asDeploy(client, deployClaimsA, async (c) => {
      const r = await c.query('select relative_path from artifacts')
      return r.rows.map((x) => x.relative_path)
    })
    expect(rows).toContain('renders/for-deploy.png')
    await client.query('delete from artifacts where revision_id = $1', [revA])
  })

  it('deployment cannot read another revision', async () => {
    const rows = await asDeploy(client, deployClaimsA, async (c) => {
      const r = await c.query('select id from revisions')
      return r.rows.map((x) => x.id)
    })
    expect(rows).toEqual([revA])
  })

  it('deployment cannot reach brand assets at all', async () => {
    // Not "sees zero rows" — no grant exists, so the table is unreachable. A
    // deploy box publishes finished artifacts and has no reason to open a logo.
    const denial = await asDeploy(client, deployClaimsA, (c) =>
      attempt(c, 'select id from brand_assets'),
    )
    expect(denial.denied).toBe(true)
  })

  it('a generation token cannot assume the deploy role', async () => {
    const rows = await asDeploy(client, claimsA, async (c) => {
      // claimsA carries role `sandbox_run`, so `app.is_deploy()` is false and
      // every deploy policy declines regardless of the connected role.
      const r = await c.query('select id from revisions')
      return r.rows
    })
    expect(rows).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Malformed tokens are not weaker runs — they are not runs
  // -------------------------------------------------------------------------

  it('grants nothing when the revision claim is missing', async () => {
    const rows = await asRun(
      client,
      { role: 'sandbox_run', run_id: runA, brand_kit_id: kitA },
      async (c) => {
        const r = await c.query('select id from revisions')
        return r.rows
      },
    )
    expect(rows).toEqual([])
  })

  it('grants nothing when the role claim is wrong', async () => {
    const rows = await asRun(client, { ...claimsA, role: 'authenticated' as never }, async (c) => {
      const r = await c.query('select id from brand_assets')
      return r.rows
    })
    expect(rows).toEqual([])
  })

  it('grants nothing with no claims at all', async () => {
    const rows = await asRun(client, {}, async (c) => {
      const r = await c.query('select id from brand_kits')
      return r.rows
    })
    expect(rows).toEqual([])
  })

  // -------------------------------------------------------------------------
  // Storage prefixes
  // -------------------------------------------------------------------------

  it('derives its own work prefix and no other', async () => {
    const prefix = await asRun(client, claimsA, async (c) => {
      const r = await c.query('select app.run_work_prefix() as p')
      return r.rows[0].p
    })
    expect(prefix).toBe(`${reqA}/rev-1`)
    expect(prefix).not.toContain(reqB)
  })

  it('cannot derive a prefix without a revision claim', async () => {
    const prefix = await asRun(client, { role: 'sandbox_run', run_id: runA }, async (c) => {
      const r = await c.query('select app.run_work_prefix() as p')
      return r.rows[0].p
    })
    // Null, not a partial path. A prefix of `/` would match the whole bucket.
    expect(prefix).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Token minting needs no database
// ---------------------------------------------------------------------------

describe('run token', () => {
  const secret = 'test-secret-not-a-real-one'
  const projectRef = 'testref'
  const claims = { run_id: 'r', revision_id: 'v', brand_kit_id: 'k' }

  it('produces three base64url segments', () => {
    const parts = mintRunToken(claims, { secret, projectRef }).split('.')
    expect(parts).toHaveLength(3)
    for (const p of parts) expect(p).not.toMatch(/[+/=]/)
  })

  it('carries every claim Supabase requires, and nothing more', () => {
    const payload = decodePayload(mintRunToken(claims, { secret, projectRef }))
    // `ref` earned its place here: a token without it is signed correctly and
    // still rejected with a bare 401, which is indistinguishable from a wrong
    // secret. The assertion exists so that can never regress silently.
    expect(Object.keys(payload).sort()).toEqual([
      'brand_kit_id',
      'exp',
      'iat',
      'iss',
      'ref',
      'revision_id',
      'role',
      'run_id',
    ])
    expect(payload.role).toBe('sandbox_run')
    expect(payload.iss).toBe('supabase')
  })

  it('defaults to the same 20-minute budget as the sandbox timeout', () => {
    const payload = decodePayload(mintRunToken(claims, { secret, projectRef, now: 1_000_000_000 }))
    expect((payload.exp as number) - (payload.iat as number)).toBe(20 * 60)
  })

  it('honours an explicit lifetime', () => {
    const payload = decodePayload(
      mintRunToken(claims, { secret, projectRef, ttlSeconds: 90, now: 1_000_000_000 }),
    )
    expect((payload.exp as number) - (payload.iat as number)).toBe(90)
  })

  it('changes signature when any claim changes', () => {
    const a = mintRunToken(claims, { secret, projectRef, now: 1_000_000_000 })
    const b = mintRunToken({ ...claims, brand_kit_id: 'other' }, { secret, projectRef, now: 1_000_000_000 })
    expect(a.split('.')[2]).not.toBe(b.split('.')[2])
  })

  it('changes signature when the secret changes', () => {
    const a = mintRunToken(claims, { secret, projectRef, now: 1_000_000_000 })
    const b = mintRunToken(claims, { secret: 'other', projectRef, now: 1_000_000_000 })
    expect(a.split('.')[2]).not.toBe(b.split('.')[2])
  })

  it('never contains the signing secret', () => {
    expect(mintRunToken(claims, { secret, projectRef })).not.toContain(secret)
  })
})
