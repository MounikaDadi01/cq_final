import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadBrain, paletteIsMachineReadable, resolveFamily } from '../src/brain'
import { readEnvFile } from '../src/openai-image'

/**
 * One-off product verification. Deliberately excluded from `npm test`.
 *
 *     npm run verify          # from eval/
 *
 * Everything else in tests/ is fast and side-effect free, so it can run on every
 * change. This file is the opposite: it writes real rows, uploads real objects and
 * shells out to the real ingest binary against the live project. Run on every save
 * it would be slow and would leave debris in the middle of ordinary work, so it is
 * excluded in vitest.config.ts rather than merely skipped — the guarantee is that
 * nothing here fires unless it is asked for by name.
 *
 * What it is for: answering "does the product actually work" on demand — before a
 * demo, after a refactor, when something feels wrong.
 *
 * Every case here covers a bug that was real, that was found by running the thing
 * rather than by testing it, and that would come back silently. That is the whole
 * selection rule. Two of them were cross-tenant writes, where a silent regression
 * is not a broken screen but one customer's data landing in another's kit.
 *
 * Fixtures are namespaced `verify-*` and removed in teardown. A crashed run leaves
 * those rows behind; they are inert and the next run overwrites them.
 */

// Credentials from the shell if present, otherwise the repo .env, so a one-off run
// needs no setup. The rest of the suite reads process.env only, because it is
// expected to run inside an already-configured shell.
let fileEnv: Record<string, string> = {}
try {
  fileEnv = readEnvFile(join(import.meta.dirname, '..', '..', '.env'))
} catch {
  /* no .env is fine when the shell already carries the keys */
}
const env = { ...fileEnv, ...process.env }

const URL_BASE = env.SUPABASE_URL
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
const ready = Boolean(URL_BASE && SERVICE)
const describeVerify = ready ? describe : describe.skip

if (!ready) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n  product-verification SKIPPED — missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n' +
      '  NOTHING about the product has been verified by this run.\n',
  )
}

const headers = { apikey: SERVICE as string, Authorization: `Bearer ${SERVICE}` }

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : null) as T
}

/**
 * Every object under a prefix.
 *
 * Storage lists one level at a time and marks a folder by returning a null id, so
 * a flat listing needs the recursion. Depth is bounded because a cycle here would
 * hang the suite rather than fail it.
 */
async function listObjects(prefix: string, depth = 0): Promise<string[]> {
  if (depth > 4) return []
  const response = await fetch(`${URL_BASE}/storage/v1/object/list/brains`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 500 }),
  })
  if (!response.ok) return []
  const rows = (await response.json()) as { name: string; id: string | null }[]
  const found: string[] = []
  for (const row of rows) {
    if (row.id === null) found.push(...(await listObjects(`${prefix}${row.name}/`, depth + 1)))
    else found.push(`${prefix}${row.name}`)
  }
  return found
}

async function download(key: string): Promise<Buffer> {
  const response = await fetch(`${URL_BASE}/storage/v1/object/brains/${key}`, { headers })
  if (!response.ok) throw new Error(`could not fetch ${key}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const EVAL_DIR = join(import.meta.dirname, '..')

const runIngest = (dir: string, kit: string) =>
  execFileSync('npx', ['tsx', 'scripts/ingest-to-supabase.ts', '--dir', dir, '--kit', kit], {
    cwd: EVAL_DIR,
    encoding: 'utf8',
    timeout: 240_000,
  })

const codesFor = (kitId: string) =>
  rest<{ code: string }[]>(`findings?kit_id=eq.${encodeURIComponent(kitId)}&select=code`).then((rows) =>
    rows.map((r) => r.code).join(','),
  )

interface Kit {
  id: string
  customer_id: string
  ingest_status: string
}

// ---------------------------------------------------------------------------

describeVerify('a brand can be rebuilt from Supabase alone', () => {
  let kits: Kit[] = []

  beforeAll(async () => {
    kits = await rest<Kit[]>('brand_kits?select=id,customer_id,ingest_status&order=id')
  })

  it('there is something to verify', () => {
    expect(kits.length).toBeGreaterThan(0)
  })

  it('every ready kit yields a usable brain with no local folder', async () => {
    /**
     * The bug: the launcher loaded brands from a directory on one laptop, so a kit
     * added through the UI could never render — `no brain for bk-northwind-2026`.
     * This walks the same path the launcher now takes (download the prefix, load it
     * as a brain) and asserts the result is actually usable, not merely present.
     */
    const ready = kits.filter((k) => k.ingest_status === 'ready')
    expect(ready.length, 'no kit is ready, so nothing was checked').toBeGreaterThan(0)

    for (const kit of ready) {
      const keys = await listObjects(`${kit.id}/`)
      expect(keys.length, `${kit.id} is ready but has no files in storage`).toBeGreaterThan(0)

      const dir = mkdtempSync(join(tmpdir(), `verify-${kit.id}-`))
      try {
        for (const key of keys) {
          const target = join(dir, key.slice(kit.id.length + 1))
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, await download(key))
        }

        const brain = loadBrain(dir)
        expect(brain.hasDesignDoc, `${kit.id} has no DESIGN.md in storage`).toBe(true)
        expect(
          existsSync(join(dir, 'brand', 'asset_manifest.json')),
          `${kit.id} has no asset manifest in storage`,
        ).toBe(true)

        /**
         * Three gaps that are each allowed, and each only allowed if something says
         * so out loud. Silence is the failure mode: an ad rendered with no logo and
         * no explanation is the shape of every brand bug in this project.
         */
        const usable = brain.assets.filter((a) => a.exists && a.kitId === kit.id)
        if (usable.length === 0) {
          expect(await codesFor(kit.id), `${kit.id} has no usable asset and no finding`).toMatch(/asset/)
        }

        const heading = brain.type.heading
        if (heading && !resolveFamily(brain, heading).resolvedFamilySlug) {
          expect(await codesFor(kit.id), `${kit.id} names ${heading} and nothing reports it`).toMatch(/font/)
        }

        if (!paletteIsMachineReadable(brain)) {
          expect(await codesFor(kit.id), `${kit.id} has no readable palette and no finding`).toMatch(
            /palette|colour|color/,
          )
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 300_000)

  it('a blocked kit ships nothing and says why', async () => {
    for (const kit of kits.filter((k) => k.ingest_status === 'blocked')) {
      // Refusing to ingest has to mean refusing to upload, or something downstream
      // will find files for an unusable kit and try to build with them.
      expect(await listObjects(`${kit.id}/`), `${kit.id} is blocked but has files in storage`).toEqual([])
      const findings = await rest<{ severity: string }[]>(
        `findings?kit_id=eq.${encodeURIComponent(kit.id)}&select=severity`,
      )
      expect(
        findings.some((f) => f.severity === 'blocker'),
        `${kit.id} is blocked with no blocker recorded to explain it`,
      ).toBe(true)
    }
  })

  it('an inspiration only sits under the brand it is named for', async () => {
    /**
     * The rule is the filename prefix, and it is enforced in two independent
     * places: upload files by prefix, and the launcher attaches only what matches.
     * This checks the resting state, which is what a run actually reads.
     */
    for (const kit of kits) {
      const slugs = [
        kit.customer_id.toLowerCase(),
        kit.id.toLowerCase().replace(/^bk-/, '').replace(/-\d{4}$/, ''),
      ]
      for (const key of await listObjects(`${kit.id}/inspirations/`)) {
        const name = key.split('/').pop()!.toLowerCase()
        expect(
          slugs.some((s) => name.startsWith(`${s}-`) || name.startsWith(`${s}_`)),
          `${key} is filed under ${kit.id} but its name matches none of ${slugs.join(', ')}`,
        ).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------

describeVerify('ingest cannot be used to reach another customer', () => {
  const victimKit = 'bk-verify-victim'
  const victimCustomer = 'verify-victim'
  const attackerKit = 'bk-verify-attacker'
  const attackerCustomer = 'verify-attacker'
  const victimLogoKey = `${victimKit}/brand/victim-logo.svg`

  let staging = ''
  let victimDigest = ''

  beforeAll(async () => {
    for (const [id, customer, name] of [
      [victimKit, victimCustomer, 'Verify Victim'],
      [attackerKit, attackerCustomer, 'Verify Attacker'],
    ]) {
      await rest('brand_kits', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          id,
          customer_id: customer,
          display_name: name,
          ingest_status: id === victimKit ? 'ready' : 'pending',
        }),
      })
    }

    // The victim's own logo, so an overwrite is detectable by digest.
    const logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')
    victimDigest = createHash('sha256').update(logo).digest('hex')
    await fetch(`${URL_BASE}/storage/v1/object/brains/${victimLogoKey}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'image/svg+xml', 'x-upsert': 'true' },
      body: new Uint8Array(logo),
    })

    /**
     * The attacker's upload carries three separate attempts at the victim:
     *   - a manifest-level `brand_kit_id` claiming the victim's kit
     *   - an entry claiming the victim's exact storage path, with different bytes
     *   - a path that climbs out of the staging directory entirely
     * All three are things a customer can put in a zip and drag onto the UI.
     */
    staging = mkdtempSync(join(tmpdir(), 'verify-attack-'))
    mkdirSync(join(staging, 'brand'), { recursive: true })
    writeFileSync(
      join(staging, 'DESIGN.md'),
      [
        '# Verify Attacker',
        '',
        '## Palette',
        '',
        '- primary: #C81E1E',
        '- surface: #FFFFFF',
        '- ink: #101010',
        '',
        '## Type',
        '',
        '- heading: Barlow',
        '- body: Barlow',
        '',
        '## Type scale',
        '',
        '- h1: 40px',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(staging, 'brand', 'asset_manifest.json'),
      JSON.stringify(
        {
          brand_kit_id: victimKit,
          assets: [
            { kind: 'logo', path: 'brand/victim-logo.svg', brand_kit_id: victimKit },
            { kind: 'logo_reverse', path: '../../../.env', brand_kit_id: attackerKit },
          ],
        },
        null,
        2,
      ),
    )
    writeFileSync(
      join(staging, 'brand', 'victim-logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><rect width="9" height="9" fill="#C81E1E"/></svg>',
    )

    runIngest(staging, attackerKit)
  }, 300_000)

  afterAll(async () => {
    for (const kit of [attackerKit, victimKit]) {
      await rest(`brand_assets?found_in_kit_id=eq.${kit}`, { method: 'DELETE' }).catch(() => {})
      await rest(`brand_fonts?kit_id=eq.${kit}`, { method: 'DELETE' }).catch(() => {})
      await rest(`findings?kit_id=eq.${kit}`, { method: 'DELETE' }).catch(() => {})
      for (const key of await listObjects(`${kit}/`)) {
        await fetch(`${URL_BASE}/storage/v1/object/brains/${key}`, { method: 'DELETE', headers }).catch(
          () => {},
        )
      }
      await rest(`brand_kits?id=eq.${kit}`, { method: 'DELETE' }).catch(() => {})
    }
    if (staging) rmSync(staging, { recursive: true, force: true })
  })

  it('attributes no row to the kit the manifest claims', async () => {
    /**
     * The IDOR. `kit_id` is the column every policy filters on, so a row created
     * with the victim's kit id is a row that appears inside the victim's own UI.
     * Ownership must come from the caller's authorisation, never from the file.
     */
    const rows = await rest<{ kit_id: string; manifest_path: string }[]>(
      `brand_assets?found_in_kit_id=eq.${attackerKit}&select=kit_id,manifest_path`,
    )
    expect(rows.length, 'ingest recorded nothing, so nothing was proven').toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.kit_id, `${row.manifest_path} was attributed to ${row.kit_id}`).toBe(attackerKit)
    }
  })

  it('does not overwrite the victim’s file', async () => {
    const digest = createHash('sha256').update(await download(victimLogoKey)).digest('hex')
    expect(digest, 'the victim’s logo bytes were replaced by the attacker’s upload').toBe(victimDigest)
  })

  it('does not touch the victim’s kit row', async () => {
    const [kit] = await rest<Kit[]>(`brand_kits?id=eq.${victimKit}&select=id,customer_id,ingest_status`)
    expect(kit, 'the victim’s kit row is gone').toBeTruthy()
    // A merge-duplicates upsert keyed on id would have rewritten customer_id here,
    // detaching the kit from the customer who owns it.
    expect(kit.customer_id).toBe(victimCustomer)
    expect(kit.ingest_status).toBe('ready')
  })

  it('refuses a path that climbs out of the upload', async () => {
    const rows = await rest<{ manifest_path: string; available: boolean; storage_key: string | null }[]>(
      `brand_assets?found_in_kit_id=eq.${attackerKit}&select=manifest_path,available,storage_key`,
    )
    const escaping = rows.find((r) => r.manifest_path.includes('..'))
    // Recorded-and-refused, not dropped: a silently missing entry looks identical
    // to a manifest that never listed it.
    expect(escaping, 'the traversal entry vanished instead of being recorded as refused').toBeTruthy()
    expect(escaping!.available, 'a refused path was marked available').toBe(false)
    expect(escaping!.storage_key, 'a refused path was given a storage key').toBeNull()

    const keys = await listObjects(`${attackerKit}/`)
    expect(
      keys.filter((k) => /\.env|\.\./.test(k)),
      'a file from outside the upload reached the bucket',
    ).toEqual([])
  })

  it('never renames the customer of an existing kit', async () => {
    /**
     * This one cost a whole tenancy. The UI created the kit with the real customer,
     * then ingest upserted `customer_id` to the staging folder's name — and the
     * person who uploaded the brand could no longer see it, because every policy
     * filters on that column. Re-ingesting is when it struck, so the test
     * re-ingests.
     */
    const before = await rest<Kit[]>(`brand_kits?id=eq.${attackerKit}&select=id,customer_id,ingest_status`)
    expect(before[0]?.customer_id).toBe(attackerCustomer)
    runIngest(staging, attackerKit)
    const after = await rest<Kit[]>(`brand_kits?id=eq.${attackerKit}&select=id,customer_id,ingest_status`)
    expect(after[0].customer_id, 'a second ingest renamed the customer').toBe(attackerCustomer)
  }, 300_000)
})

// ---------------------------------------------------------------------------

describeVerify('a launch failure is reported rather than swallowed', () => {
  const WEB = env.CQ_WEB_URL ?? 'http://localhost:3100'

  it('the run endpoint returns a reason instead of a silent 200', async () => {
    /**
     * The bug: the launcher was spawned with its output discarded, so a refusal —
     * a stale sandbox template, in the case that cost an afternoon — left the
     * request at `draft` with no run row, no error and nothing in the UI. The
     * guard's careful message went to a closed pipe.
     *
     * A well-formed revision id that does not exist takes the same path any
     * structural refusal takes: fail early, and say so to the caller.
     */
    const alive = await fetch(`${WEB}/api/session`)
      .then((r) => r.ok)
      .catch(() => false)
    if (!alive) {
      // Loud, and not a pass. A skipped case that reads as green is the thing this
      // whole file exists to avoid.
      throw new Error(
        `the web app is not answering on ${WEB} — start it with \`npm run dev\` in web/, ` +
          'or set CQ_WEB_URL. This case was NOT verified.',
      )
    }

    const { customers } = (await fetch(`${WEB}/api/session`).then((r) => r.json())) as {
      customers: { customer_id: string }[]
    }
    const customer = customers[0]?.customer_id
    expect(customer, 'no customer to sign in as').toBeTruthy()

    const signIn = await fetch(`${WEB}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: customer }),
    })
    const cookie = signIn.headers.getSetCookie().join('; ')
    expect(cookie, 'sign-in returned no session cookie').toContain('cq_session')

    const response = await fetch(`${WEB}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ revision_id: '00000000-0000-4000-8000-0000000000ff', mode: 'revise' }),
    })

    // 404 if the ownership check refuses first, 500 if the launcher does. Either is
    // a report. A 200 followed by silence is the regression.
    expect([404, 500], `the run endpoint answered ${response.status}`).toContain(response.status)
    const body = await response.text()
    expect(body.replace(/\W/g, '').length, 'refused with an empty body').toBeGreaterThan(3)
  }, 90_000)
})
