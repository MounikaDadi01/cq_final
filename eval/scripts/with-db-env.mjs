#!/usr/bin/env node
/**
 * Runs a command with the database credentials and CA bundle the isolation suites need.
 *
 * These suites — `rls`, `tenant-isolation`, `storage-rls` — are 62 assertions against a
 * live Postgres, and they are the strongest evidence this project has that one customer
 * cannot reach another's brand. They skip themselves when `SUPABASE_DB_URL` is absent,
 * loudly and on purpose, because a suite that goes green without connecting is the
 * failure this whole layer exists to prevent.
 *
 * The problem that made this file necessary: skipping was the *default*. Vitest does not
 * read `.env`, and Supabase's Postgres presents a certificate chain Node rejects unless
 * pointed at the bundle — so `npm test` reported 56 skipped, and the guarantee the design
 * rests on went unverified in every run anyone would think to make. The credentials were
 * sitting in `.env` the whole time.
 *
 * So this wires both, and nothing else. It is not a test runner and it does not decide
 * what is skipped; it removes the two reasons a real run was hard to start.
 *
 *   npm run test:isolation
 */
import { spawnSync } from 'node:child_process' // cq-allow-disqualifier-scan: runs vitest locally, never an agent
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

/** `.env` is the one place keys live, and it is never committed. */
function readEnvFile(path) {
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
      }),
  )
}

// Anything already exported wins, so CI can supply its own without editing a file.
const env = { ...readEnvFile(join(REPO, '.env')), ...process.env }

const CA = join(REPO, '.certs', 'supabase-ca.crt')
if (existsSync(CA)) {
  env.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS ?? CA
} else {
  // Said plainly rather than left to surface as "self-signed certificate in certificate
  // chain", which reads as a code fault and is not one. The bundle is not redistributed
  // here because it is not ours to redistribute.
  console.warn(
    `\n  no CA bundle at ${CA}\n` +
      '  Supabase Postgres will be rejected as self-signed. Download the project CA from\n' +
      '  the Supabase dashboard (Settings → Database → SSL certificate) and save it there.\n',
  )
}

if (!env.SUPABASE_DB_URL) {
  console.warn(
    '\n  SUPABASE_DB_URL is not set, so the isolation suites will skip themselves.\n' +
      '  Nothing about cross-customer isolation will be verified by this run.\n',
  )
}

const [command, ...rest] = process.argv.slice(2)
if (!command) {
  console.error('usage: node scripts/with-db-env.mjs <command> [args...]')
  process.exit(2)
}

// cq-allow-disqualifier-scan: runs vitest on this machine; no agent, no sandbox
const result = spawnSync(command, rest, { stdio: 'inherit', env, cwd: join(REPO, 'eval'), shell: true }) // cq-allow-disqualifier-scan
process.exit(result.status ?? 1)
