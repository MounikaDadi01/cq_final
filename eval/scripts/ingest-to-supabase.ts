/**
 * Ingest: put a brain into Supabase so a run can pull it.
 *
 * Runs on the backend, with `service_role`, which is the one place that key is
 * allowed. It bypasses RLS entirely — that is precisely why ingest is a backend job
 * and not something a sandbox could ever do for itself.
 *
 * Three properties this has to get right, and each has a planted trap behind it:
 *
 *   1. **Identity comes from the manifest, not the folder.** An asset's owning kit
 *      is whatever its manifest entry says. One asset in this packet is tagged to a
 *      different kit than the folder it sits in, and recording it by folder would
 *      hand one tenant another's logo.
 *
 *   2. **A path is not an asset.** A manifest entry whose file does not exist is
 *      recorded as unavailable with the reason, never silently dropped. Dropping it
 *      makes "the brand has no reverse logo" and "we forgot to look" identical.
 *
 *   3. **The token cache is never uploaded.** It disagrees with DESIGN.md three ways
 *      and is the newer file, so anything resolving by recency picks wrong. The
 *      cheapest way not to consult it is for it not to be there.
 *
 *   npx tsx scripts/ingest-to-supabase.ts            # every brain in the packet
 *   npx tsx scripts/ingest-to-supabase.ts --dry-run
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { discoverBrains, loadBrain, type Brain } from '../src/brain'
import { planIngest, availableAssets, reviewFindings, isBlocked } from '../src/ingest'
import { readEnvFile } from '../src/openai-image'

const ROOT = join(import.meta.dirname, '..', '..')
const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env }
const DRY = process.argv.includes('--dry-run')

const SUPABASE_URL = env.SUPABASE_URL
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')

/** Files a brain contains that must never reach the bucket. */
const WITHHELD = ['brand/tokens.json']

const headers = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
}

async function rest(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

async function upload(bucket: string, key: string, bytes: Buffer, contentType: string) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${key}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: new Uint8Array(bytes),
  })
  if (!response.ok) {
    throw new Error(`upload ${key}: ${response.status} ${(await response.text()).slice(0, 200)}`)
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
}
const typeOf = (path: string) =>
  CONTENT_TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream'

/**
 * True when a manifest path stays inside the brain directory.
 *
 * A manifest is a file, and when it arrives by upload it is untrusted input. A `path`
 * of `../../../.env` would be read by `readFileSync(join(brain.dir, path))` and then
 * uploaded into a bucket — ingest runs with `service_role`, so that is arbitrary local
 * file exfiltration through a brand upload.
 *
 * Resolved and compared rather than pattern-matched, because `a/../../b` and
 * `.%2e/` and a symlink all defeat a substring check for `..`.
 */
function insideBrain(brainDir: string, path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\0')) return false
  const base = resolve(brainDir)
  const target = resolve(base, path)
  return target === base ? false : target.startsWith(base + sep)
}

/** True when a storage key stays inside its owner's prefix. */
function insidePrefix(owner: string, key: string): boolean {
  const segments = key.split('/')
  return segments[0] === owner && !segments.includes('..') && !segments.includes('')
}

interface Upload {
  /** Path within the brain on disk. */
  path: string
  /** Bucket key. The first segment decides who can read the bytes. */
  key: string
  purpose: string
}

/**
 * Every file a run may need, keyed by the kit that OWNS it.
 *
 * The keying is the security boundary, and getting it wrong is invisible in the
 * database. Storage policy scopes reads by the first path segment, so an asset
 * stored under the folder it was *found* in is readable by that tenant even when
 * its `brand_assets` row is hidden from them. Row-level isolation and object-level
 * isolation have to agree, and only the owning kit id makes them agree.
 *
 * Concretely: this packet has one asset tagged to a different kit than its folder.
 * Uploading it by folder would hide the row from the wrong tenant and hand them the
 * bytes anyway.
 */
function filesFor(brain: Brain): Upload[] {
  /**
   * Only files that exist.
   *
   * The list was written against the packet, where every brain ships a README and a
   * DESIGN.md. A real upload does not: a kit with no README crashed ingest on
   * `readFileSync`, and because the crash happened *after* the kit row was created, the
   * kit sat at `pending` forever with no assets, no fonts and no findings — the exact
   * half-ingested state the `pending` status exists to prevent a run from using, but
   * with nothing to explain it.
   */
  const files: Upload[] = [
    // Documents and fonts belong to the brain they ship in.
    { path: 'DESIGN.md', key: `${brain.kitId}/DESIGN.md`, purpose: 'the brand — outranks every other artifact' },
    { path: 'README.md', key: `${brain.kitId}/README.md`, purpose: 'what each file is, and its authority' },
    {
      path: 'brand/asset_manifest.json',
      key: `${brain.kitId}/brand/asset_manifest.json`,
      purpose: 'staged assets with their owning kit ids',
    },
  ]
  for (const asset of brain.assets) {
    if (!asset.exists) continue

    // Refuse a path that leaves the brain directory. Dropped rather than sanitised: a
    // manifest entry pointing outside its own kit is not a typo to be corrected.
    if (!insideBrain(brain.dir, asset.path)) {
      console.log(`   REFUSED ${asset.path} — escapes the brain directory`)
      continue
    }

    /**
     * Who owns this asset.
     *
     * On operator-staged brains the manifest is trusted, and honouring a foreign
     * `brand_kit_id` is how the packet's misfiled asset is reunited with its owner.
     * On an *upload* the manifest is attacker-controlled, and honouring it would let
     * anyone write into another tenant's prefix by naming it — including overwriting
     * their logo, because ingest holds `service_role`.
     *
     * Same field, opposite trust. `forcedKitId` is set only on the upload path, so it
     * is also the signal for which of the two this is.
     */
    const claimed = asset.kitId || brain.kitId
    const owner = forcedKitId ? forcedKitId : claimed
    if (forcedKitId && claimed !== forcedKitId) {
      console.log(
        `   note: ${asset.path} claims ${claimed}; an upload cannot assign ownership, ` +
          `storing under ${forcedKitId} and recording it`,
      )
    }

    const key = `${owner}/${asset.path}`
    if (!insidePrefix(owner, key)) {
      console.log(`   REFUSED ${asset.path} — key would escape the ${owner} prefix`)
      continue
    }

    files.push({
      path: asset.path,
      key,
      purpose:
        claimed === brain.kitId
          ? `${asset.kind} asset`
          : `${asset.kind} asset whose manifest claims ${claimed}`,
    })
  }
  for (const font of brain.fonts) {
    const rel = relative(brain.dir, font.path)
    files.push({
      path: rel,
      key: `${brain.kitId}/${rel}`,
      purpose: `${font.familySlug} ${font.weight} — a family named but not shipped is a substitution`,
    })
  }
  return files
    .filter((f) => !WITHHELD.includes(f.path))
    .filter((f) => existsSync(join(brain.dir, f.path)))
}

/**
 * Where to ingest from.
 *
 * `--dir` points at a single staged upload, `--kit` names the kit it belongs to. The UI
 * uses both: it writes a dropped folder to a staging directory and calls this, so the
 * definition of "what a brand is" lives here alone rather than being reimplemented
 * against an upload stream where the two would drift.
 */
const dirFlag = process.argv.indexOf('--dir')
const kitFlag = process.argv.indexOf('--kit')
const singleDir = dirFlag !== -1 ? process.argv[dirFlag + 1] : null
const forcedKitId = kitFlag !== -1 ? process.argv[kitFlag + 1] : null

/** A directory is worth ingesting if it holds the brand, by either of its two names. */
const looksLikeABrain = (dir: string) =>
  existsSync(join(dir, 'DESIGN.md')) || existsSync(join(dir, 'brand', 'asset_manifest.json'))

/**
 * The brain inside an upload, which is not always the directory handed over.
 *
 * A browser reports each file's path relative to the folder that was *chosen*, so what
 * arrives depends on where the person clicked: pick `harborline` and the brain is at the
 * top, pick the folder above it and every path carries a `harborline/` segment the
 * uploader knows nothing about. One staged kit came through as
 * `.staging-kits/bk-harborline-2026/harborline/DESIGN.md`, ingest looked for
 * `DESIGN.md` at the root, found none, and marked a complete brand `blocked` —
 * with its files already sitting correctly in storage. The upload was fine; the
 * assumption about where it landed was not.
 *
 * So descend rather than assume. Only through a single wrapper, and only when that
 * child is unambiguously the brain: two candidate children mean the upload holds more
 * than one brand, and picking one silently is how the wrong brand gets ingested under
 * this kit's id. That case still blocks, which is correct.
 *
 * Recorded on stdout rather than done quietly — the launcher log is where someone looks
 * when a kit ingested as something they did not expect.
 */
function resolveBrainRoot(dir: string): string {
  if (looksLikeABrain(dir)) return dir
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return dir

  const candidates = readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((child) => statSync(child).isDirectory() && looksLikeABrain(child))

  if (candidates.length === 1) {
    console.log(`   note: the brain is one level down, in ${relative(dir, candidates[0])}/`)
    return candidates[0]
  }
  if (candidates.length > 1) {
    console.log(
      `   note: ${candidates.length} folders here look like brains — ` +
        'refusing to choose one; upload a single brand kit',
    )
  }
  return dir
}

const brains = singleDir
  ? [loadBrain(resolveBrainRoot(singleDir))]
  : discoverBrains(join(ROOT, 'packet', 'design-brains'))
console.log(`\ningest · ${brains.length} brain(s)${DRY ? ' · DRY RUN' : ''}\n`)

for (const rawBrain of brains) {
  /**
   * The kit id the caller asked for wins over the one in the manifest.
   *
   * An uploaded manifest may name a kit that does not exist here, or none at all, or —
   * worst — one belonging to somebody else. The row was already created under the
   * caller's id, so trusting the file would either orphan the assets or attach them to
   * another tenant. Per-asset ownership still comes from each entry's own
   * `brand_kit_id`, which is how the misfiled-asset case keeps working.
   */
  const brain: Brain = forcedKitId ? { ...rawBrain, kitId: forcedKitId } : rawBrain
  if (forcedKitId && rawBrain.kitId && rawBrain.kitId !== forcedKitId) {
    console.log(`   note: manifest says ${rawBrain.kitId}, ingesting as ${forcedKitId} as asked`)
  }
  const plan = planIngest(brain.dir)
  const available = availableAssets(plan)
  const findings = reviewFindings(plan)
  const files = filesFor(brain)

  console.log(`── ${brain.slug}  kit=${brain.kitId}`)

  /**
   * A blocked kit is recorded and skipped, not attempted.
   *
   * Pushing on produced a `pending` kit with no rows and no explanation — worse than a
   * refusal, because `pending` reads as "still working" rather than "cannot be used".
   */
  if (!DRY && isBlocked(plan)) {
    const already = (await rest(
      `brand_kits?id=eq.${encodeURIComponent(brain.kitId)}&select=id`,
    )) as { id: string }[] | null
    if (Array.isArray(already) && already.length) {
      // Status only. Who the customer is was decided when the row was created.
      await rest(`brand_kits?id=eq.${encodeURIComponent(brain.kitId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ingest_status: 'blocked' }),
      })
    } else {
      await rest('brand_kits', {
        method: 'POST',
        body: JSON.stringify({
          id: brain.kitId,
          customer_id: brain.slug,
          display_name: brain.slug,
          ingest_status: 'blocked',
        }),
      })
    }
    await rest(`findings?kit_id=eq.${encodeURIComponent(brain.kitId)}&revision_id=is.null`, {
      method: 'DELETE',
    })
    await rest('findings', {
      method: 'POST',
      body: JSON.stringify(
        plan.findings.map((f) => ({
          kit_id: brain.kitId,
          code: f.code,
          severity: 'blocker',
          detail: f.detail,
        })),
      ),
    })
    for (const f of plan.findings) console.log(`   blocker: ${f.code} — ${f.detail.slice(0, 90)}`)
    console.log('   BLOCKED — recorded and skipped\n')
    continue
  }
  console.log(`   assets: ${brain.assets.length} in manifest, ${available.length} available to runs`)
  console.log(`   fonts : ${brain.fonts.length}`)
  console.log(`   files : ${files.length} to upload (${WITHHELD.length} withheld)`)
  for (const f of findings) console.log(`   finding: ${f.code} — ${f.detail.slice(0, 96)}`)

  if (DRY) {
    for (const f of files) {
      const foreign = !f.key.startsWith(`${brain.kitId}/`)
      console.log(`   would upload  brains/${f.key}${foreign ? '   <-- stored under its OWNER' : ''}`)
    }
    continue
  }

  /**
   * The kit row. Created if absent; otherwise only the status is touched.
   *
   * This used to upsert `customer_id` from the directory name, which quietly reassigned
   * an existing kit to whatever folder ingest happened to read. A UI upload creates the
   * row with the real customer and stages files under the kit id, so ingest renamed the
   * customer to `bk-…-2026` and the person who uploaded it could no longer see their own
   * brand — every policy filters on `customer_id`.
   *
   * Ingest owns the ingest outcome. It does not own who the customer is.
   */
  const existingRow = (await rest(
    `brand_kits?id=eq.${encodeURIComponent(brain.kitId)}&select=id`,
  )) as { id: string }[] | null
  if (Array.isArray(existingRow) && existingRow.length) {
    await rest(`brand_kits?id=eq.${encodeURIComponent(brain.kitId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ ingest_status: 'pending' }),
    })
  } else {
    await rest('brand_kits', {
      method: 'POST',
      body: JSON.stringify({
        id: brain.kitId,
        customer_id: brain.slug,
        display_name: brain.slug,
        ingest_status: 'pending',
      }),
    })
  }

  // Assets are replaced wholesale rather than merged, so a manifest entry removed
  // upstream disappears here too. A stale row pointing at a withdrawn logo is worse
  // than no row: something would place it.
  await rest(`brand_assets?found_in_kit_id=eq.${encodeURIComponent(brain.kitId)}`, { method: 'DELETE' })
  await rest(`brand_fonts?kit_id=eq.${encodeURIComponent(brain.kitId)}`, { method: 'DELETE' })
  await rest(`findings?kit_id=eq.${encodeURIComponent(brain.kitId)}&revision_id=is.null`, {
    method: 'DELETE',
  })

  for (const f of files) {
    const bytes = readFileSync(join(brain.dir, f.path))
    await upload('brains', f.key, bytes, typeOf(f.path))
  }
  console.log(`   uploaded ${files.length} file(s) to brains/${brain.kitId}/`)

  const assetRows = brain.assets
    .filter((asset) => insideBrain(brain.dir, asset.path) || !asset.exists)
    .map((asset) => ({
    /**
     * The owning kit.
     *
     * Trusted from the manifest for an operator-staged brain, forced to the caller's
     * kit for an upload. An uploaded manifest claiming another tenant's id would
     * otherwise create rows owned by that tenant — a cross-tenant write performed by
     * the victim's own policies, which would then show the attacker's asset in the
     * victim's UI.
     */
    kit_id: forcedKitId ?? (asset.kitId || brain.kitId),
    found_in_kit_id: brain.kitId,
    kind: asset.kind,
    manifest_path: asset.path,
    // Matches where the bytes actually went.
    storage_key:
      asset.exists && insideBrain(brain.dir, asset.path)
        ? `${forcedKitId ?? (asset.kitId || brain.kitId)}/${asset.path}`
        : null,
    // Recorded so a manifest that claimed someone else's kit is visible rather than
    // silently rewritten.
    notes:
      forcedKitId && asset.kitId && asset.kitId !== forcedKitId
        ? `manifest claimed ${asset.kitId}; an upload cannot assign ownership` +
          (asset.notes ? ` · ${asset.notes}` : '')
        : (asset.notes ?? null),
    /**
     * Available means "a run can open this". A refused path is not available.
     *
     * Without this, an entry like `../../../.env` was recorded as available with a null
     * storage key — a row claiming bytes that were deliberately never stored, which is
     * the same class of lie as a byte count that disagrees with its object.
     */
    available: asset.exists && insideBrain(brain.dir, asset.path),
    unavailable_reason: !asset.exists
      ? 'no file behind the manifest entry'
      : insideBrain(brain.dir, asset.path)
        ? null
        : 'the manifest path escapes the brain directory and was refused',
    natural_width: asset.naturalWidth ?? null,
    natural_height: asset.naturalHeight ?? null,
  }))

  // A foreign-tagged asset references a kit that may not exist yet as a row, and
  // the FK would refuse it. Insert the referenced kit as a placeholder so the
  // evidence survives — it is exactly the row an isolation test needs to prove the
  // asset is invisible to the wrong tenant.
  /**
   * Placeholder rows for kits an asset claims but that do not exist yet.
   *
   * Never an upsert. `merge-duplicates` on this write would overwrite an existing kit's
   * `customer_id` with `unknown` — so a manifest naming a kit id would detach // cq-allow-disqualifier-scan: illustrative comment
   * that customer's kit from them, locking them out of their own brand. Existence is checked
   * and an existing row is left completely alone.
   */
  const foreignKits = [...new Set(assetRows.map((r) => r.kit_id))].filter((k) => k !== brain.kitId)
  for (const kit of foreignKits) {
    const existing = await rest(`brand_kits?id=eq.${encodeURIComponent(kit)}&select=id`)
    if (Array.isArray(existing) && existing.length) {
      console.log(`   note: asset claims ${kit}, which already exists — left untouched`)
      continue
    }
    await rest('brand_kits', {
      method: 'POST',
      body: JSON.stringify({
        id: kit,
        customer_id: 'unknown',
        display_name: kit,
        ingest_status: 'pending',
      }),
    })
    console.log(`   note: asset claims ${kit} — placeholder kit row created`)
  }

  await rest('brand_assets', { method: 'POST', body: JSON.stringify(assetRows) })

  await rest('brand_fonts', {
    method: 'POST',
    body: JSON.stringify(
      brain.fonts.map((font) => ({
        kit_id: brain.kitId,
        family_slug: font.familySlug,
        weight: font.weight,
        style: font.style ?? 'normal',
        storage_key: `${brain.kitId}/${relative(brain.dir, font.path)}`,
      })),
    ),
  })

  if (findings.length) {
    await rest('findings', {
      method: 'POST',
      body: JSON.stringify(
        findings.map((f) => ({
          kit_id: brain.kitId,
          code: f.code,
          // Ingest never emits a blocker: a brand problem is for a person to see,
          // not a reason to refuse the brand.
          severity: 'review',
          detail: f.detail,
        })),
      ),
    })
  }

  /**
   * `ready` last, and only if nothing blocks.
   *
   * A blocked kit stays `blocked` so a launcher refuses to run against it. Marking a
   * brand with no DESIGN.md as ready would let it produce an ad with no palette, no
   * type and no scale — which is worse than refusing, because it looks like a result.
   */
  const blocked = isBlocked(plan)
  await rest(`brand_kits?id=eq.${encodeURIComponent(brain.kitId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ingest_status: blocked ? 'blocked' : 'ready' }),
  })
  if (blocked) {
    // Recorded against the kit so the UI can explain the refusal rather than showing a
    // status with no reason attached.
    await rest('findings', {
      method: 'POST',
      body: JSON.stringify(
        // `isBlocked` already decided; these are the reasons behind it. Ingest's own
        // severity vocabulary is narrower than the database's, so the reason is
        // recorded at `blocker` here because the kit is, in fact, blocked.
        plan.findings.map((f) => ({
          kit_id: brain.kitId,
          code: f.code,
          severity: 'blocker',
          detail: f.detail,
        })),
      ),
    }).catch(() => {})
  }
  console.log(`   ${blocked ? 'BLOCKED — cannot be used' : 'ready'}\n`)
}

console.log('ingest complete\n')
