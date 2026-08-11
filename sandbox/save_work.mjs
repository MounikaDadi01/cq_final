#!/usr/bin/env node
/**
 * save_work — the agent's own hands.
 *
 * This runs *inside* the sandbox and is the only thing that moves work out of it.
 * Nothing outside the box reaches in to collect: no backend fetch, no volume mount,
 * no scp, no supervisor that copies the directory afterwards. If this script does
 * not run, the work does not exist anywhere else. That is the constraint, and it is
 * also the design.
 *
 * Deliberately dependency-free, and deliberately a plain executable. Two reasons.
 * A developer can open a shell in a live box and read this file top to bottom to
 * see exactly what leaves and where it goes — a compiled SDK call cannot be read
 * that way. And `npm install` inside a short-lived box is a failure mode with no
 * upside.
 *
 *   save_work                 # save everything not yet saved, mark progress
 *   save_work --final         # the same, then mark the revision complete
 *   save_work --dry-run       # list what would be saved, touch nothing
 *
 * Environment, supplied by the launcher:
 *
 *   SUPABASE_URL        project URL
 *   SUPABASE_ANON_KEY   the gateway key — not an authorisation, just a doorway
 *   CQ_RUN_TOKEN        the scoped run JWT. This is the whole authorisation.
 *   CQ_WORK_DIR         the tree to save, e.g. /home/user/work
 *   CQ_WORK_PREFIX      storage prefix, e.g. <request-id>/rev-<n>
 *   CQ_REVISION_ID      the revision every row is attributed to
 *   CQ_RUN_ID           this run
 *
 * There is no service_role key here and there must never be: it bypasses RLS
 * entirely, and every guarantee about what this box can touch rests on its absence.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const args = process.argv.slice(2)
const FINAL = args.includes('--final')
const DRY_RUN = args.includes('--dry-run')

/**
 * `--only <prefix>` restricts the save to paths under that prefix, relative to the work
 * directory. A trailing slash is added so `--only transcript` cannot also match a
 * sibling called `transcripts-old`.
 */
const onlyFlag = args.indexOf('--only')
const ONLY = onlyFlag !== -1 && args[onlyFlag + 1]
  ? args[onlyFlag + 1].replace(/^\/+|\/+$/g, '') + '/'
  : null

const env = (name) => {
  const value = process.env[name]
  if (!value) {
    // Fail before touching anything. A save that runs with a missing variable
    // half-succeeds, and a half-save is harder to reason about than no save.
    console.error(`save_work: ${name} is not set`)
    process.exit(2)
  }
  return value
}

const SUPABASE_URL = env('SUPABASE_URL')
const ANON = env('SUPABASE_ANON_KEY')
const TOKEN = env('CQ_RUN_TOKEN')
const WORK_DIR = env('CQ_WORK_DIR')
const PREFIX = env('CQ_WORK_PREFIX')
const REVISION_ID = env('CQ_REVISION_ID')
const RUN_ID = env('CQ_RUN_ID')

if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  // Refuse rather than warn. If this key is present the isolation argument is
  // already void, and continuing would produce a run whose guarantees are fiction.
  console.error('save_work: refusing to run — a service_role key is present in this sandbox')
  process.exit(3)
}

const headers = {
  apikey: ANON,
  Authorization: `Bearer ${TOKEN}`,
}

/** Content type from extension. Wrong types make a stored render unviewable. */
const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
}

/**
 * Classifies a file by where it sits in the tree.
 *
 * The role is not decoration: policy decides what this run may insert by role, and
 * a generation run is refused if it claims `recording`. So the classifier stays
 * conservative — anything unrecognised is `other`, never guessed into a role that
 * might be refused or, worse, accepted wrongly.
 */
function roleOf(relativePath) {
  const parts = relativePath.split('/')
  // Any RESULT file is a report, wherever it sits and whatever suffix it carries.
  //
  // Matched loosely on purpose. It was `=== 'RESULT.json'`, then
  // `endsWith('RESULT.json')`, and each time a legitimate report was classified as
  // `other` and refused by policy — most recently `deploy/RESULT-<run-id>.json`, which
  // exists precisely so each attempt keeps its own account.
  if (/(^|\/)RESULT[^/]*\.json$/.test(relativePath)) return 'result'
  // The run's own account of what it did, which is what a report is. Also the only
  // classification policy allows: a deploy box may insert `recording` and `result` and
  // nothing else (0016_deploy_fields_and_result.sql), so `other` would be refused there.
  if (parts[0] === 'transcript') return 'result'
  if (parts[0] === 'renders') return 'render'
  if (parts[0] === 'deploy') return relativePath.endsWith('.webm') ? 'recording' : 'other'
  if (parts[0]?.startsWith('html_')) {
    if (relativePath.endsWith('index.html')) return 'html'
    if (parts.includes('assets') && relativePath.endsWith('plate.png')) return 'plate'
    return 'asset'
  }
  return 'other'
}

/** The canvas a file belongs to, when its path says so. Null when it does not. */
function canvasOf(relativePath) {
  const parts = relativePath.split('/')
  if (parts[0] === 'renders') return parts[1]?.replace(/\.[^.]+$/, '') ?? null
  const dir = parts.find((p) => p.startsWith('html_'))
  return dir ? dir.slice('html_'.length) : null
}

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...walk(full))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

/**
 * Width and height from a PNG header.
 *
 * Read here rather than left for something downstream to work out, because this is the
 * only moment the bytes are in hand. Recording a render without its dimensions means
 * the one question worth asking about an ad — is it actually the size it was asked for
 * — needs a download and a decode to answer.
 *
 * Deliberately hand-parsed: IHDR is at a fixed offset, and adding an image library to a
 * dependency-free script that a developer is expected to read in a live box is a poor
 * trade for twelve bytes of arithmetic.
 */
function pngSize(bytes) {
  const PNG_MAGIC = '89504e470d0a1a0a'
  if (bytes.length < 24) return null
  if (bytes.subarray(0, 8).toString('hex') !== PNG_MAGIC) return null
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const extensionOf = (path) => {
  const dot = path.lastIndexOf('.')
  return dot === -1 ? '' : path.slice(dot).toLowerCase()
}

/** What is already recorded, so a re-run adds rather than duplicates. */
async function alreadySaved() {
  const url =
    `${SUPABASE_URL}/rest/v1/artifacts` +
    `?revision_id=eq.${encodeURIComponent(REVISION_ID)}&select=relative_path`
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`could not read existing artifacts: ${response.status} ${await response.text()}`)
  }
  return new Set((await response.json()).map((row) => row.relative_path))
}

/**
 * Uploads bytes, then records the row. This order is the whole durability story.
 *
 * Bytes first: an object with no row is an orphan — invisible, harmless, and
 * cleanable. A row with no bytes is a lie the rest of the system believes, and
 * something downstream will try to publish it.
 *
 * Deliberately NOT an upsert. Overwriting requires UPDATE on `storage.objects`, and
 * this role does not have it — a box cannot rewrite what it has already saved. That
 * collides with wanting retries to be safe, and append-only wins: a 409 on the
 * object means the bytes are already there, so the retry falls through to inserting
 * the row. Which is exactly the right recovery, because the failure this guards
 * against is a crash *between* the upload and the row.
 */
async function saveOne(relativePath, absolutePath) {
  const bytes = readFileSync(absolutePath)
  let storedBytes = bytes.length
  let storedMismatch = false
  const digest = createHash('sha256').update(bytes).digest('hex')
  const storageKey = `${PREFIX}/${relativePath}`
  const contentType = CONTENT_TYPES[extensionOf(relativePath)] ?? 'application/octet-stream'
  const size = contentType === 'image/png' ? pngSize(bytes) : null

  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/work/${storageKey}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': contentType },
    body: bytes,
  })
  if (!upload.ok) {
    const body = await upload.text()
    const alreadyThere = upload.status === 409 || /already exists|Duplicate/i.test(body)
    if (!alreadyThere) {
      throw new Error(`upload failed for ${relativePath}: ${upload.status} ${body}`)
    }
    // The bytes survived a previous attempt; the row may not have. Fall through — but
    // record what storage actually holds, not what we just computed.
    //
    // Found by auditing: a row claimed 1636 bytes while storage held 1658, because the
    // upload was refused as a duplicate and the row was written from the local file
    // anyway. A row that disagrees with its own object is worse than no row: everything
    // downstream believes it.
    console.log(`  (object already present) ${relativePath}`)
    const head = await fetch(`${SUPABASE_URL}/storage/v1/object/info/work/${storageKey}`, { headers })
    if (head.ok) {
      const info = await head.json()
      if (typeof info.size === 'number' && info.size !== bytes.length) {
        console.log(`  recording storage's size ${info.size}, not the local ${bytes.length}`)
        storedBytes = info.size
        storedMismatch = true
      }
    }
  }

  const row = {
    revision_id: REVISION_ID,
    run_id: RUN_ID,
    relative_path: relativePath,
    storage_key: storageKey,
    role: roleOf(relativePath),
    canvas_name: canvasOf(relativePath),
    content_type: contentType,
    // What storage holds. Equal to the local size unless the object was already there.
    bytes: storedBytes,
    sha256: digest,
    ...(size ? { width: size.width, height: size.height } : {}),
  }

  const insert = await fetch(`${SUPABASE_URL}/rest/v1/artifacts`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  })
  if (!insert.ok) {
    throw new Error(`record failed for ${relativePath}: ${insert.status} ${await insert.text()}`)
  }

  // Acknowledge from what came back, not from a 2xx. A write that returns no row
  // has not been read by anyone, and "the request succeeded" is a weaker claim
  // than "the row is there".
  const recorded = await insert.json()
  if (!Array.isArray(recorded) || recorded.length !== 1) {
    throw new Error(`record for ${relativePath} returned no row; treating as unsaved`)
  }

  if (storedMismatch) {
    await reportFinding(
      'artifact-already-present',
      `${relativePath} was already in storage with different bytes; the row records what ` +
        `storage holds (${storedBytes}) and this run's copy (${bytes.length}) was not written`,
      'review',
    )
  }
  return { relativePath, storageKey, bytes: storedBytes, digest, role: row.role, size }
}

/**
 * Moves the revision's status. Partial is a real state, not a failure.
 *
 * Skipped entirely on a deploy box. A deploy does not own the revision's lifecycle —
 * it publishes work that is already complete and approved — and `sandbox_deploy` has
 * no update grant on `revisions`, so attempting it produced a 403 that aborted the
 * save and lost the recording. The permission was right; the caller was wrong.
 */
async function setRevisionStatus(status) {
  if (process.env.CQ_SANDBOX_KIND === 'deployment') return
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/revisions?id=eq.${encodeURIComponent(REVISION_ID)}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  )
  if (!response.ok) {
    throw new Error(`could not set revision status: ${response.status} ${await response.text()}`)
  }
}

async function reportFinding(code, detail, severity = 'review') {
  // Reporting must never be the thing that fails a run, so a failure here is
  // logged and swallowed rather than thrown.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/findings`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision_id: REVISION_ID, run_id: RUN_ID, code, severity, detail }),
    })
  } catch (error) {
    console.error(`save_work: could not record finding ${code}: ${error.message}`)
  }
}

async function main() {
  let tree
  try {
    tree = walk(WORK_DIR)
  } catch (error) {
    console.error(`save_work: cannot read ${WORK_DIR}: ${error.message}`)
    process.exit(4)
  }

  const candidates = tree
    .map((absolute) => ({ absolute, relativePath: relative(WORK_DIR, absolute).split(sep).join('/') }))
    /**
     * `--only <prefix>` narrows the save to one subtree.
     *
     * For the periodic transcript flush. Without it a flush saves everything new in the
     * tree, which sounds generous and is not: a PNG caught half-written would be stored
     * and filed as a `render`, and the front end would show a corrupt canvas as finished
     * work. Append-only means that row cannot be replaced afterwards.
     *
     * So a flush says what it means. A bare `save_work` still saves the whole tree, and
     * `--final` is unchanged.
     */
    .filter((c) => (ONLY ? c.relativePath.startsWith(ONLY) : true))
    // Deterministic order so two runs over the same tree save in the same
    // sequence, which makes a partial save comparable to another partial save.
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))

  if (candidates.length === 0) {
    console.error('save_work: nothing in the work directory')
    // Not an error exit: a run that legitimately produced nothing should still be
    // able to mark itself, and the caller decides what that means.
  }

  const done = DRY_RUN ? new Set() : await alreadySaved()
  const pending = candidates.filter((c) => !done.has(c.relativePath))

  if (DRY_RUN) {
    for (const c of pending) {
      const size = statSync(c.absolute).size
      console.log(`would save  ${roleOf(c.relativePath).padEnd(9)} ${c.relativePath}  ${size}B`)
    }
    console.log(`\n${pending.length} file(s), prefix work/${PREFIX}/`)
    return
  }

  /**
   * Partial before the first byte moves, so a box that dies mid-save is already
   * labelled as having incomplete work rather than looking untouched.
   *
   * Skipped for `--only`. A targeted flush is not an attempt to save the run's work, so
   * it has no business describing the run's progress — and on a deploy box the revision
   * it would relabel is an *approved* one, which a transcript flush marking `partial`
   * every thirty seconds would quietly demote.
   */
  if (!ONLY) await setRevisionStatus('partial')

  const saved = []
  const failed = []

  for (const c of pending) {
    try {
      const result = await saveOne(c.relativePath, c.absolute)
      saved.push(result)
      console.log(
        `saved ${result.role.padEnd(9)} ${result.relativePath}  ${result.bytes}B` +
          `${result.size ? `  ${result.size.width}x${result.size.height}` : ''}` +
          `  ${result.digest.slice(0, 12)}`,
      )
    } catch (error) {
      // One file failing must not abandon the rest. A run that saves nine of ten
      // renders is worth far more than one that stops at the first refusal.
      failed.push({ path: c.relativePath, message: error.message })
      console.error(`FAILED ${c.relativePath}: ${error.message}`)
    }
  }

  if (failed.length) {
    await reportFinding(
      'save-incomplete',
      `${failed.length} of ${pending.length} files could not be saved: ` +
        failed.map((f) => `${f.path} (${f.message})`).join('; '),
      'blocker',
    )
  }

  if (FINAL) {
    if (failed.length) {
      // Refuse to call it complete. `--final` is a request, not an instruction:
      // a revision marked complete with missing artifacts would be published.
      console.error('save_work: not marking complete — some files failed to save')
      process.exitCode = 1
    } else {
      await setRevisionStatus('complete')
      console.log('revision marked complete')
    }
  }

  console.log(
    `\n${saved.length} saved, ${failed.length} failed, ` +
      `${done.size} already recorded, prefix work/${PREFIX}/`,
  )
}

main().catch(async (error) => {
  console.error(`save_work: ${error.message}`)
  await reportFinding('save-aborted', error.message, 'blocker')
  process.exit(1)
})
