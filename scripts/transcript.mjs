#!/usr/bin/env node
/**
 * Renders a working transcript of a session to a text file.
 *
 * Scripted rather than written by hand for two reasons. It can be re-run at any
 * point to pick up everything since the last render, so the transcript never drifts
 * from what actually happened. And it redacts — a session log contains tool output,
 * and tool output has touched connection strings and API keys.
 *
 * Redaction is deliberately over-eager. A transcript with a placeholder where a
 * token used to be is a small annoyance; a transcript with a live service_role key
 * in it is a credential leak that survives in whatever the file is pasted into.
 *
 *   node scripts/transcript.mjs                 # newest session
 *   node scripts/transcript.mjs <session-id>    # a specific one
 *   node scripts/transcript.mjs --out FILE.txt
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROJECT_SLUG = '-Users-mounikadadi-Downloads-characterquilt-work-trial'
const SESSIONS_DIR = join(homedir(), '.claude', 'projects', PROJECT_SLUG)

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const outPath = outFlag !== -1 ? args[outFlag + 1] : 'TRANSCRIPT.txt'
const wantedId = args.find((a) => !a.startsWith('--') && a !== outPath)

/**
 * Redact credentials, keep everything else verbatim.
 *
 * The transcript is meant to be pushed, so it cannot carry live keys. Two layers,
 * because they catch different things:
 *
 *   patterns    — recognise a key by its shape, so a rotated key is still caught
 *   .env values — literal matches for anything whose key name looks secret, which
 *                 covers credentials that look like ordinary words
 *
 * These leaked into tool output by reading `.env`, not by being typed. Nothing else
 * is touched: the working record stays word for word.
 */
const REDACTIONS = [
  [/postgres(?:ql)?:\/\/[^\s"']+/g, 'postgresql://<redacted>'],
  [/sk-svcacct-[A-Za-z0-9_-]+/g, 'sk-svcacct-<redacted>'],
  [/sk-proj-[A-Za-z0-9_-]+/g, 'sk-proj-<redacted>'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-<redacted>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt-redacted>'],
  [/sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, 'sb_<redacted>'],
  [/e2b_[A-Za-z0-9]{16,}/g, 'e2b_<redacted>'],
]

/** Literal values from .env whose key name looks like a secret. */
function envSecrets() {
  const SECRET_KEYS = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|DB_URL|CREDENTIAL)/i
  try {
    return readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      })
      .filter(([k, v]) => SECRET_KEYS.test(k) && v.length >= 8)
      .map(([, v]) => v)
  } catch {
    return []
  }
}

for (const value of envSecrets()) {
  REDACTIONS.push([new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<env-secret-redacted>'])
}

const redact = (text) =>
  REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)

/**
 * Tool output is where the bulk lives, so by default it is clipped.
 *
 * `--full` keeps everything. Redaction still applies — losslessness is about not
 * dropping the record, not about preserving credentials verbatim.
 */
const FULL = args.includes('--full')
const TOOL_OUTPUT_LIMIT = FULL ? Infinity : 1200
const TEXT_LIMIT = FULL ? Infinity : 6000

function pickSession() {
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, path: join(SESSIONS_DIR, f), mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (wantedId) {
    const hit = files.find((x) => x.f.startsWith(wantedId))
    if (!hit) throw new Error(`no session file starting with ${wantedId}`)
    return hit
  }
  // Largest, not newest: the working session is the one with the volume in it.
  return files.sort((a, b) => statSync(b.path).size - statSync(a.path).size)[0]
}

const clip = (text, limit) => {
  const t = text.replace(/\r/g, '')
  if (limit === Infinity || t.length <= limit) return t
  return `${t.slice(0, limit)}\n    … [${t.length - limit} more characters omitted]`
}

/**
 * Local time, not UTC.
 *
 * The log stores UTC. Rendering it raw made a single working day — 10am to 7:35pm
 * Pacific — read as spanning two dates, because the evening crossed midnight UTC.
 * A transcript is for a person reconstructing what happened, so it uses the clock
 * that person was looking at, and says which one that is.
 */
const TZ_LABEL = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
  .formatToParts(new Date())
  .find((p) => p.type === 'timeZoneName')?.value ?? 'local'

const stamp = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

function blocksOf(message) {
  const content = message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

const session = pickSession()
const lines = readFileSync(session.path, 'utf8').split('\n').filter(Boolean)

const out = []
let userTurns = 0
let assistantTurns = 0
let toolCalls = 0
const toolCounts = new Map()
let firstStamp = ''
let lastStamp = ''

for (const line of lines) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    continue
  }

  const when = stamp(entry.timestamp)
  if (when) {
    if (!firstStamp) firstStamp = when
    lastStamp = when
  }

  const role = entry.message?.role ?? entry.type
  const blocks = blocksOf(entry.message)

  if (role === 'user') {
    // Tool results arrive as user-role messages; they are not the human speaking.
    const isToolResult = blocks.some((b) => b.type === 'tool_result')
    if (isToolResult) {
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        const body =
          typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c) => c.text ?? `[${c.type}]`).join('\n')
              : ''
        if (!body.trim()) continue
        out.push(`    RESULT: ${clip(redact(body), TOOL_OUTPUT_LIMIT).replace(/\n/g, '\n    ')}`)
      }
      continue
    }

    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) continue
    // System reminders are injected context, not the human's words.
    const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (!cleaned) continue

    userTurns++
    out.push('')
    out.push('='.repeat(78))
    out.push(`USER  [${when}]  turn ${userTurns}`)
    out.push('='.repeat(78))
    out.push(clip(redact(cleaned), TEXT_LIMIT))
    continue
  }

  if (role === 'assistant') {
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    const tools = blocks.filter((b) => b.type === 'tool_use')

    if (text) {
      assistantTurns++
      out.push('')
      out.push(`--- ASSISTANT [${when}] ---`)
      out.push(clip(redact(text), TEXT_LIMIT))
    }

    for (const t of tools) {
      toolCalls++
      toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + 1)
      const input = t.input ?? {}
      // One informative line per call. The full arguments are usually a file body,
      // which is already on disk and does not need duplicating here.
      const summary =
        input.description ??
        input.command ??
        input.file_path ??
        input.pattern ??
        input.query ??
        input.prompt ??
        JSON.stringify(input).slice(0, 160)
      out.push(`    → ${t.name}: ${clip(redact(String(summary)), 200)}`)
    }
  }
}

const header = [
  'WORKING TRANSCRIPT — CharacterQuilt design engine trial',
  '',
  `Session          ${session.f}`,
  `Rendered         ${stamp(new Date().toISOString())} ${TZ_LABEL}`,
  `Covers           ${firstStamp} → ${lastStamp} (${TZ_LABEL})`,
  `Human turns      ${userTurns}`,
  `Assistant turns  ${assistantTurns}`,
  `Tool calls       ${toolCalls}`,
  '',
  'Tool use by kind:',
  ...[...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `  ${String(n).padStart(4)}  ${name}`),
  '',
  'Notes on this rendering:',
  '  · Credentials are redacted — API keys, JWTs, connection strings, and any',
  '    .env value whose key name looks secret. Everything else is verbatim.',
  FULL
    ? '  · Lossless: no tool output or message text has been clipped.'
    : `  · Tool output is clipped to ${TOOL_OUTPUT_LIMIT} characters per result. Re-run`,
  FULL ? '' : '    with --full for the complete record.',
  '  · Re-run `node scripts/transcript.mjs` to pick up everything since.',
  '',
  '='.repeat(78),
].join('\n')

writeFileSync(outPath, `${header}\n${out.join('\n')}\n`)

const bytes = statSync(outPath).size
console.log(`wrote ${outPath} — ${(bytes / 1024).toFixed(0)} KB`)
console.log(`  ${userTurns} human turns, ${assistantTurns} assistant turns, ${toolCalls} tool calls`)
console.log(`  source: ${session.f} (${(statSync(session.path).size / 1048576).toFixed(1)} MB)`)
