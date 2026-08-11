import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { asAppUser, asRun, attempt, connect, uuid } from '../src/rls'

/**
 * Two customers, and the question asked from the human side.
 *
 * The sandbox path already has its own suite. This one exists because the UI is a
 * new attack surface with a different credential: a person signed in as one customer
 * must not be able to reach another's work through any query a frontend could make.
 *
 * "Never mix" is a database property here, not a frontend discipline. Every
 * assertion below is therefore a refusal at the policy layer, reached with a session
 * that carries only a customer id — the same thing a browser would hold.
 */

const DB_URL = process.env.SUPABASE_DB_URL
const describeDb = DB_URL ? describe : describe.skip

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.warn('\n  tenant-isolation.test.ts SKIPPED — no SUPABASE_DB_URL.\n' +
    '  Cross-customer isolation has NOT been verified by this run.\n')
}

describeDb('cross-customer isolation, from the human side', () => {
  let client: Client
  let end: () => Promise<void>

  const stamp = Date.now()
  const custA = `cust-a-${stamp}`
  const custB = `cust-b-${stamp}`
  const kitA = `kit-a-${stamp}`
  const kitB = `kit-b-${stamp}`
  const reqA = uuid()
  const reqB = uuid()
  const revA = uuid()
  const revB = uuid()
  const runA = uuid()
  const runB = uuid()
  const threadA = uuid()
  const threadB = uuid()

  const userA = { role: 'app_user' as const, customer_id: custA }
  const userB = { role: 'app_user' as const, customer_id: custB }

  beforeAll(async () => {
    const c = await connect(DB_URL as string)
    client = c.client
    end = c.end

    await client.query(
      `insert into brand_kits (id, customer_id, display_name, ingest_status)
       values ($1,$3,'A','ready'), ($2,$4,'B','ready')`,
      [kitA, kitB, custA, custB],
    )
    // The packet's planted shape: owned by A, filed under B.
    await client.query(
      `insert into brand_assets (kit_id, found_in_kit_id, kind, manifest_path, available)
       values ($1,$2,'logo_reverse','brand/misfiled.svg',true),
              ($1,$1,'logo','brand/a-logo.svg',true),
              ($2,$2,'logo','brand/b-logo.svg',true)`,
      [kitA, kitB],
    )
    await client.query(
      `insert into requests (id, kit_id, kind, campaign_name)
       values ($1,$3,'new','A campaign'), ($2,$4,'new','B campaign')`,
      [reqA, reqB, kitA, kitB],
    )
    await client.query(`insert into revisions (id, request_id, n) values ($1,$3,1), ($2,$4,1)`, [
      revA, revB, reqA, reqB,
    ])
    await client.query(
      `insert into runs (id, revision_id, sandbox_provider) values ($1,$3,'e2b'), ($2,$4,'e2b')`,
      [runA, runB, revA, revB],
    )
    await client.query(
      `insert into artifacts (revision_id, relative_path, storage_key, role)
       values ($1,'renders/square.png','a/rev-1/renders/square.png','render'),
              ($2,'renders/square.png','b/rev-1/renders/square.png','render')`,
      [revA, revB],
    )
    await client.query(
      `insert into comment_threads (id, request_id, opened_on_revision, canvas_name,
                                    region_x, region_y, region_w, region_h)
       values ($1,$3,$5,'square',0.14,0.16,0.56,0.22),
              ($2,$4,$6,'square',0.10,0.10,0.30,0.30)`,
      [threadA, threadB, reqA, reqB, revA, revB],
    )
    await client.query(
      `insert into comment_messages (thread_id, author, body, instruction)
       values ($1,'user','A only: tighten the headline','Tighten the headline to two lines'),
              ($2,'user','B only: move the logo','Move the logo to the top right')`,
      [threadA, threadB],
    )
    await client.query('commit').catch(() => {})
  })

  afterAll(async () => {
    if (!client) return
    await client.query('delete from requests where kit_id = any($1)', [[kitA, kitB]])
    await client.query('delete from brand_assets where found_in_kit_id = any($1)', [[kitA, kitB]])
    await client.query('delete from brand_kits where id = any($1)', [[kitA, kitB]])
    await end()
  })

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  it('sees only its own kit', async () => {
    const rows = await asAppUser(client, userA, async (c) =>
      (await c.query('select id from brand_kits')).rows.map((r) => r.id),
    )
    expect(rows).toEqual([kitA])
  })

  it('sees only its own requests', async () => {
    const rows = await asAppUser(client, userB, async (c) =>
      (await c.query('select campaign_name from requests')).rows.map((r) => r.campaign_name),
    )
    expect(rows).toEqual(['B campaign'])
  })

  it('sees only its own revisions and artifacts', async () => {
    const seen = await asAppUser(client, userA, async (c) => ({
      revisions: (await c.query('select id from revisions')).rows.map((r) => r.id),
      artifacts: (await c.query('select storage_key from artifacts')).rows.map((r) => r.storage_key),
    }))
    expect(seen.revisions).toEqual([revA])
    expect(seen.artifacts).toEqual(['a/rev-1/renders/square.png'])
  })

  it('cannot read another customer’s comment thread or message', async () => {
    const seen = await asAppUser(client, userA, async (c) => ({
      threads: (await c.query('select id from comment_threads')).rows.map((r) => r.id),
      bodies: (await c.query('select body from comment_messages')).rows.map((r) => r.body),
    }))
    expect(seen.threads).toEqual([threadA])
    expect(seen.bodies).toEqual(['A only: tighten the headline'])
  })

  it('sees its own asset even when filed under the other customer', async () => {
    // Ownership follows kit_id, so A reaches its misfiled asset and B does not.
    const a = await asAppUser(client, userA, async (c) =>
      (await c.query('select manifest_path from brand_assets order by manifest_path')).rows.map((r) => r.manifest_path),
    )
    const b = await asAppUser(client, userB, async (c) =>
      (await c.query('select manifest_path from brand_assets')).rows.map((r) => r.manifest_path),
    )
    expect(a).toEqual(['brand/a-logo.svg', 'brand/misfiled.svg'])
    expect(b).toEqual(['brand/b-logo.svg'])
  })

  it('derives storage prefixes for its own requests only', async () => {
    const prefixes = await asAppUser(client, userA, async (c) =>
      (await c.query('select * from app.user_request_prefixes()')).rows.map((r) => Object.values(r)[0]),
    )
    expect(prefixes).toEqual([reqA])
    expect(prefixes).not.toContain(reqB)
  })

  // -------------------------------------------------------------------------
  // Writes a person must not be able to make
  // -------------------------------------------------------------------------

  it('cannot open a comment thread on another customer’s request', async () => {
    const denial = await asAppUser(client, userA, (c) =>
      attempt(
        c,
        `insert into comment_threads (request_id, canvas_name, region_x, region_y, region_w, region_h)
         values ($1,'square',0.1,0.1,0.2,0.2)`,
        [reqB],
      ),
    )
    expect(denial.denied).toBe(true)
  })

  it('cannot post as the agent', async () => {
    // A person writing `author = 'agent'` would make the record of who said what
    // untrustworthy, which is the whole value of the thread.
    const denial = await asAppUser(client, userA, (c) =>
      attempt(c, `insert into comment_messages (thread_id, author, body) values ($1,'agent','not me')`, [threadA]),
    )
    expect(denial.denied).toBe(true)
  })

  it('can comment on its own thread as itself', async () => {
    const denial = await asAppUser(client, userA, (c) =>
      attempt(c, `insert into comment_messages (thread_id, author, body) values ($1,'user','ok')`, [threadA]),
    )
    expect(denial.denied).toBe(false)
  })

  it('cannot produce an artifact', async () => {
    // Only a run makes work. A person able to insert an artifact row could claim
    // an ad exists that no run ever produced.
    const denial = await asAppUser(client, userA, (c) =>
      attempt(
        c,
        `insert into artifacts (revision_id, relative_path, storage_key, role)
         values ($1,'renders/forged.png','x','render')`,
        [revA],
      ),
    )
    expect(denial.denied).toBe(true)
  })

  it('cannot stage a brand asset', async () => {
    const denial = await asAppUser(client, userA, (c) =>
      attempt(
        c,
        `insert into brand_assets (kit_id, found_in_kit_id, kind, manifest_path, available)
         values ($1,$1,'logo','brand/forged.svg',true)`,
        [kitA],
      ),
    )
    expect(denial.denied).toBe(true)
  })

  it('cannot start a run', async () => {
    const denial = await asAppUser(client, userA, (c) =>
      attempt(c, `insert into runs (revision_id, sandbox_provider) values ($1,'e2b')`, [revA]),
    )
    expect(denial.denied).toBe(true)
  })

  it('cannot update another customer’s revision', async () => {
    const denial = await asAppUser(client, userA, (c) =>
      attempt(c, `update revisions set status = 'complete' where id = $1`, [revB]),
    )
    expect(denial.denied).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Malformed sessions
  // -------------------------------------------------------------------------

  it('grants nothing without a customer claim', async () => {
    const rows = await asAppUser(client, { role: 'app_user' }, async (c) =>
      (await c.query('select id from brand_kits')).rows,
    )
    expect(rows).toEqual([])
  })

  it('grants nothing when the role claim is a sandbox role', async () => {
    // Connected as app_user but claiming to be a run: both predicates require the
    // claim and the connection to agree, so neither set of policies applies.
    const rows = await asAppUser(
      client,
      { role: 'sandbox_run', customer_id: custA, run_id: runA, revision_id: revA, brand_kit_id: kitA },
      async (c) => (await c.query('select id from requests')).rows,
    )
    expect(rows).toEqual([])
  })

  it('a run token cannot borrow the app_user policies', async () => {
    // The mirror of the above, from the sandbox side.
    const rows = await asRun(
      client,
      { role: 'app_user', customer_id: custA },
      async (c) => (await c.query('select id from brand_kits')).rows,
    )
    expect(rows).toEqual([])
  })

  it('a run sees comments on its own request and nothing else', async () => {
    const rows = await asRun(
      client,
      { role: 'sandbox_run', run_id: runA, revision_id: revA, brand_kit_id: kitA },
      async (c) => (await c.query('select body from comment_messages')).rows.map((r) => r.body),
    )
    expect(rows).toEqual(['A only: tighten the headline'])
  })

  it('a run cannot resolve a thread', async () => {
    // A person decides whether their own comment was addressed. A run marking its
    // own work resolved would be grading itself.
    const denial = await asRun(
      client,
      { role: 'sandbox_run', run_id: runA, revision_id: revA, brand_kit_id: kitA },
      (c) => attempt(c, `update comment_threads set status = 'resolved' where id = $1`, [threadA]),
    )
    expect(denial.denied).toBe(true)
  })
})
