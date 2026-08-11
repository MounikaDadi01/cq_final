import { spawn } from 'node:child_process' // cq-allow-disqualifier-scan: spawns the ingest worker, never an agent
import { mkdirSync, openSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { serviceFetch } from '@/lib/server'

/**
 * Create a customer and its first brand kit, then ingest the files dropped in.
 *
 * This is the one route that creates a *tenant*, so it is the one route where the
 * tenancy rules have to be established rather than enforced by them. Three guards:
 *
 *   1. A new customer id must not already exist. Creating a kit under an id somebody
 *      else owns is the whole failure mode, and it is an equality check.
 *   2. A kit id must not already exist either, for the same reason.
 *   3. Ids are pattern-checked before they reach a path or a storage prefix.
 *
 * Ingest runs as a detached backend job because it holds `service_role` and writes
 * brand rows — neither of which a person may do.
 */
const ID = /^[a-z0-9][a-z0-9-]{1,48}$/

export async function POST(request: Request) {
  /**
   * No session is required, and that is a deliberate narrowing of what this route
   * protects rather than an oversight.
   *
   * Onboarding happens on the switch-customer screen, which is by definition reached
   * with no session — so requiring one made "add a customer" unreachable at the only
   * moment anybody wants it. The check it replaces was never a tenancy boundary either:
   * any session would do, including the new customer's neighbour's.
   *
   * What still holds, and is what actually matters here: a new customer or kit id must
   * not already exist, so this cannot adopt or write into a brand somebody already
   * owns. Ownership of existing data is unaffected — every other route reads and writes
   * with the session token and the database's own policies.
   *
   * What no longer holds: creating a *new* tenant is open. That is correct for a local
   * trial with passwordless sign-in, and is the thing to put behind real auth first if
   * this were ever deployed.
   */
  const form = await request.formData()
  const customerId = String(form.get('customer_id') ?? '').trim().toLowerCase()
  const kitId = String(form.get('kit_id') ?? '').trim().toLowerCase()
  const displayName = String(form.get('display_name') ?? '').trim() || customerId

  if (!ID.test(customerId)) {
    return Response.json({ error: 'customer id must be lowercase letters, numbers and hyphens' }, { status: 400 })
  }
  if (!ID.test(kitId)) {
    return Response.json({ error: 'kit id must be lowercase letters, numbers and hyphens' }, { status: 400 })
  }

  // Refuse to touch anything that exists. An "add customer" that can adopt an existing
  // customer or kit is a way to reach another tenant's data by naming it.
  const existingKit = await serviceFetch(`/rest/v1/brand_kits?id=eq.${encodeURIComponent(kitId)}&select=id`)
  if (Array.isArray(existingKit) && existingKit.length) {
    return Response.json({ error: `kit ${kitId} already exists` }, { status: 409 })
  }
  const existingCustomer = await serviceFetch(
    `/rest/v1/brand_kits?customer_id=eq.${encodeURIComponent(customerId)}&select=id&limit=1`,
  )
  if (Array.isArray(existingCustomer) && existingCustomer.length) {
    return Response.json(
      { error: `customer ${customerId} already exists — upload into its kit instead` },
      { status: 409 },
    )
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) return Response.json({ error: 'no files were dropped' }, { status: 400 })

  /**
   * Files are written to a staging directory, then ingested from there.
   *
   * Ingest already knows how to read a brain off disk, resolve its manifest, index its
   * fonts and record every finding. Reimplementing that against an upload stream would
   * mean two code paths deciding what a brand is, and they would drift.
   */
  const staging = join(process.cwd(), '..', '.staging-kits', kitId)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  const stored: string[] = []
  for (const file of files) {
    // `webkitRelativePath` arrives when a whole folder is dropped, so the structure the
    // customer sent is preserved rather than flattened — `brand/` and `fonts/` mean
    // something to ingest.
    const relative = String(form.get(`path:${file.name}`) ?? file.name)
    if (relative.includes('..') || relative.startsWith('/')) {
      return Response.json({ error: `refusing a path, not a filename: ${relative}` }, { status: 400 })
    }
    if (!/\.(md|json|svg|png|jpg|jpeg|ttf|otf|woff2?)$/i.test(relative)) continue
    if (file.size > 8 * 1024 * 1024) {
      return Response.json({ error: `${relative} is larger than 8 MB` }, { status: 400 })
    }
    const target = join(staging, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, new Uint8Array(await file.arrayBuffer()))
    stored.push(relative)
  }
  if (stored.length === 0) {
    return Response.json({ error: 'none of those files are brand files we accept' }, { status: 400 })
  }

  // The kit row first, as `pending`. A launcher refuses to run against a kit that is
  // not `ready`, so a half-ingested brand cannot produce an ad missing its fonts.
  await serviceFetch('/rest/v1/brand_kits', {
    method: 'POST',
    body: JSON.stringify({
      id: kitId,
      customer_id: customerId,
      display_name: displayName,
      ingest_status: 'pending',
    }),
  })

  /**
   * Ingest's output goes to a file, not to `/dev/null`.
   *
   * It ran with `stdio: 'ignore'` and that cost real time: a kit came back `blocked`
   * with one finding and no way to see what ingest had actually looked at. The reason
   * was in the output nobody kept. A detached job whose only trace is a status column
   * can only be debugged by guessing.
   */
  const logDir = join(process.cwd(), '.launch-logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = openSync(join(logDir, `ingest-${kitId}.log`), 'a')

  // cq-allow-disqualifier-scan: the ingest worker, not an agent — it reads a staged
  // brain and writes rows. No model runs in this process.
  const child = spawn('npx', ['tsx', 'scripts/ingest-to-supabase.ts', '--dir', staging, '--kit', kitId], { // cq-allow-disqualifier-scan: ingest worker, no model in this process
    cwd: join(process.cwd(), '..', 'eval'),
    detached: true,
    stdio: ['ignore', logFile, logFile],
  })
  child.unref()

  return Response.json({
    ok: true,
    customer_id: customerId,
    kit_id: kitId,
    files: stored.length,
    ingesting: true,
  })
}

export const dynamic = 'force-dynamic'
