/**
 * Put inspirations into Supabase, under the kit that owns them.
 *
 * They lived only on this machine and were pushed into a sandbox from disk, which is the
 * same local dependency the brand files had: a customer added through the UI could never
 * have an inspiration, and a run on another machine would silently have none.
 *
 * Two rules, both enforced here:
 *
 *   · The bucket prefix is the kit, so one customer physically cannot read another's.
 *   · The filename must begin with the brand's own slug, so a file's name and its
 *     location agree. A mismatch is refused rather than filed under whichever the
 *     caller happened to give — the two together are what make "belongs to" checkable.
 *
 *   npx tsx scripts/upload-inspirations.ts [--from <dir>] [--dry-run]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readEnvFile } from '../src/openai-image'

const ROOT = join(import.meta.dirname, '..', '..')
const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env }
const SUPABASE_URL = env.SUPABASE_URL as string
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY as string
if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')

const args = process.argv.slice(2)
const fromFlag = args.indexOf('--from')
const source = fromFlag !== -1 ? args[fromFlag + 1] : join(ROOT, 'packet', 'inspirations')
const DRY = args.includes('--dry-run')

const headers = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` }

const kits = (await fetch(`${SUPABASE_URL}/rest/v1/brand_kits?select=id,customer_id,display_name`, {
  headers,
}).then((r) => r.json())) as { id: string; customer_id: string; display_name: string }[]

/**
 * The slugs a filename may legitimately start with, per kit.
 *
 * Derived from the kit's own data rather than hardcoded, so a new brand needs no code
 * change: the customer id, the display name and the kit id all reduce to candidate
 * slugs. `bk-northwind-2026` yields `northwind`, which is what a person would type.
 */
function slugsFor(kit: { id: string; customer_id: string; display_name: string }): string[] {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const fromKit = clean(kit.id).replace(/^bk-/, '').replace(/-\d{4}$/, '')
  return [...new Set([clean(kit.customer_id), clean(kit.display_name), fromKit].filter(Boolean))]
}

if (!existsSync(source)) throw new Error(`no such directory: ${source}`)
const files = readdirSync(source).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
console.log(`\ninspirations · ${files.length} file(s) in ${source}${DRY ? ' · DRY RUN' : ''}\n`)

let placed = 0
let refused = 0

for (const file of files) {
  const name = file.toLowerCase()
  // Longest slug first, so `northwind-foods` wins over `northwind` when both match.
  const match = kits
    .flatMap((kit) => slugsFor(kit).map((slug) => ({ kit, slug })))
    .sort((a, b) => b.slug.length - a.slug.length)
    .find(({ slug }) => name.startsWith(`${slug}-`) || name.startsWith(`${slug}_`))

  if (!match) {
    console.log(`  REFUSED  ${file}`)
    console.log(`           its name matches no brand. Rename it <brand>-<something>.png`)
    console.log(`           known brands: ${[...new Set(kits.flatMap(slugsFor))].join(', ')}`)
    refused++
    continue
  }

  const key = `${match.kit.id}/inspirations/${file}`
  if (DRY) {
    console.log(`  would place  ${file}  ->  brains/${key}`)
    placed++
    continue
  }

  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/brains/${key}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'image/png', 'x-upsert': 'true' },
    body: new Uint8Array(readFileSync(join(source, file))),
  })
  if (!response.ok) {
    console.log(`  FAILED   ${file}: ${response.status} ${(await response.text()).slice(0, 120)}`)
    continue
  }
  console.log(`  placed   ${file}  ->  brains/${key}`)
  placed++
}

console.log(`\n${placed} placed, ${refused} refused\n`)
