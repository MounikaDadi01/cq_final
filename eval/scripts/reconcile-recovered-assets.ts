/**
 * Brings the database into line with what a run will actually place.
 *
 * Recovery of a misfiled reverse logo can only be measured *after* upload, and the
 * reason is structural rather than incidental. The file is declared in another
 * kit's manifest while being tagged as this kit's property, so ingest uploads the
 * bytes under the owning kit's prefix. Only then do the two files sit in one folder
 * where their skeletons can be compared — while ingesting either kit on its own,
 * one of the two is somewhere else on disk.
 *
 * So this runs as a pass over storage, not over a staging directory. For every kit
 * it materialises the prefix exactly as a run does, lets `loadBrain` apply
 * recovery, and where a kind was recovered it points the asset row at the file that
 * exists and records the evidence.
 *
 * Without this the ad and the report disagree: the render places the recovered
 * logo while the row still says the kind is unavailable. A report that contradicts
 * the artifact is worse than either being wrong alone, because there is no way to
 * tell which one to believe.
 *
 *   npx tsx scripts/reconcile-recovered-assets.ts [--dry-run]
 *
 * Storage is never modified — no rename, no copy, no delete. Only rows change, so
 * the customer's files stay exactly as delivered and the change is reversible.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadBrain } from '../src/brain'
import { readEnvFile } from '../src/openai-image'

const env = { ...readEnvFile(join(import.meta.dirname, '..', '..', '.env')), ...process.env }
const URL_BASE = env.SUPABASE_URL
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_BASE || !SERVICE) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
}
const dryRun = process.argv.includes('--dry-run')
const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }

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
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : null) as T
}

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

async function materialise(kitId: string): Promise<string | null> {
  const keys = await listObjects(`${kitId}/`)
  if (!keys.length) return null
  const dir = mkdtempSync(join(tmpdir(), `reconcile-${kitId}-`))
  for (const key of keys) {
    const response = await fetch(`${URL_BASE}/storage/v1/object/brains/${key}`, { headers })
    if (!response.ok) continue
    const target = join(dir, key.slice(kitId.length + 1))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, Buffer.from(await response.arrayBuffer()))
  }
  return dir
}

const kits = await rest<{ id: string; ingest_status: string }[]>(
  'brand_kits?select=id,ingest_status&order=id',
)

let changed = 0
for (const kit of kits) {
  if (kit.ingest_status === 'blocked') continue
  const dir = await materialise(kit.id)
  if (!dir) continue

  try {
    const brain = loadBrain(dir)
    for (const asset of brain.assets) {
      if (!asset.resolvedFrom) continue

      const [row] = await rest<{ id: string; storage_key: string | null; available: boolean }[]>(
        `brand_assets?kit_id=eq.${encodeURIComponent(kit.id)}` +
          `&kind=eq.${encodeURIComponent(asset.kind)}&select=id,storage_key,available`,
      )
      if (!row) continue

      const storageKey = `${kit.id}/${asset.resolvedFrom.path}`
      if (row.available && row.storage_key === storageKey) continue

      console.log(`${kit.id}  ${asset.kind}`)
      console.log(`   declared  ${asset.path}  (no file)`)
      console.log(`   using     ${asset.resolvedFrom.path}`)
      console.log(`   because   ${asset.resolvedFrom.reason}`)
      if (dryRun) {
        console.log('   --dry-run, nothing written\n')
        // Counted even though nothing was written, so the summary reports what
        // *would* change. A dry run that ends "nothing to reconcile" after listing
        // a change is the kind of output that gets believed over the detail above it.
        changed++
        continue
      }

      await rest(`brand_assets?id=eq.${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          storage_key: storageKey,
          available: true,
          unavailable_reason: null,
          notes:
            `declared ${asset.path}, which is not in the kit; resolved to ` +
            `${asset.resolvedFrom.path} — ${asset.resolvedFrom.reason}`,
        }),
      })

      /**
       * Replace the stale finding rather than adding to it. Leaving
       * `asset-missing-file` in place beside the recovery would report a problem
       * that no longer affects any render, and a report nobody trusts gets ignored
       * wholesale — including the parts that are true.
       */
      await rest(
        `findings?kit_id=eq.${encodeURIComponent(kit.id)}&code=eq.asset-missing-file` +
          `&detail=like.*${encodeURIComponent(asset.path)}*`,
        { method: 'DELETE' },
      ).catch(() => {})

      const existing = await rest<{ id: string }[]>(
        `findings?kit_id=eq.${encodeURIComponent(kit.id)}&code=eq.asset-reverse-recovered&select=id`,
      )
      if (!existing.length) {
        await rest('findings', {
          method: 'POST',
          body: JSON.stringify({
            kit_id: kit.id,
            code: 'asset-reverse-recovered',
            severity: 'review',
            outcome: 'pass',
            detail:
              `${asset.path} is listed as "${asset.kind}" but no file exists; ` +
              `${asset.resolvedFrom.path} was used instead — ${asset.resolvedFrom.reason}`,
          }),
        })
      }
      changed++
      console.log('   row and finding updated\n')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(
  changed === 0
    ? 'nothing to reconcile — every declared kind already points at a file that exists'
    : dryRun
      ? `${changed} asset row(s) would be reconciled; re-run without --dry-run to apply`
      : `${changed} asset row(s) reconciled`,
)
