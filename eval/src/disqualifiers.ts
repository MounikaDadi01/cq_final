import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

/**
 * Static scanners, one per listed disqualifier that has an exact answer.
 *
 * Each takes content rather than reading the world, so a planted violation can
 * be handed to it directly. That matters: a scanner that has never fired is
 * indistinguishable from a clean codebase, and right now the app tree is empty,
 * so scanning it would pass for the wrong reason.
 *
 * One disqualifier is deliberately absent. "A hardcoded ordering" cannot be
 * settled by reading source — it is proven by running the interleaved
 * concurrent case and observing that nothing crossed and nothing waited.
 */

export interface Violation {
  rule: string
  file: string
  line: number
  evidence: string
}

export interface SourceFile {
  path: string
  content: string
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.packet',
  'coverage',
])

export function collectSourceFiles(root: string): SourceFile[] {
  if (!existsSync(root)) return []
  const out: SourceFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRECTORIES.has(name)) continue
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (CODE_EXTENSIONS.has(extname(name))) {
        out.push({ path: relative(root, full), content: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(root)
  return out
}

function scanLines(
  files: SourceFile[],
  rule: string,
  patterns: RegExp[],
): Violation[] {
  const out: Violation[] = []
  for (const file of files) {
    const lines = file.content.split(/\r?\n/)
    lines.forEach((line, index) => {
      if (isIgnored(line)) return
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          out.push({ rule, file: file.path, line: index + 1, evidence: line.trim() })
          return
        }
      }
    })
  }
  return out
}

/** An explicit, auditable escape hatch beats a scanner people disable. */
function isIgnored(line: string): boolean {
  return /cq-allow-disqualifier-scan/.test(line)
}

/**
 * "Your backend launching the agent as a subprocess on its own box."
 * The agent may not live where the backend lives.
 */
export function scanNoLocalProcessSpawning(files: SourceFile[]): Violation[] {
  return scanLines(files, 'no-local-process-spawning', [
    /\bfrom\s+['"](?:node:)?child_process['"]/,
    /\brequire\(\s*['"](?:node:)?child_process['"]\s*\)/,
    /\b(?:execSync|execFileSync|spawnSync|execFile)\s*\(/,
    /\bspawn\s*\(/,
    /\bclaude\s+-p\b/,
  ])
}

/**
 * The same disqualifier from the dependency side: an agent runtime present in
 * the backend package is a loaded gun regardless of whether it is fired.
 */
export function scanNoAgentRuntimeDependency(packageJson: string): Violation[] {
  const pkg = JSON.parse(packageJson)
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  }
  const banned = [/claude-agent-sdk/, /claude-code/, /^@openai\/agents/, /^codex/]
  const out: Violation[] = []
  for (const name of Object.keys(deps)) {
    if (banned.some((b) => b.test(name))) {
      out.push({
        rule: 'no-agent-runtime-in-backend',
        file: pkg.name ? `${pkg.name}/package.json` : 'package.json',
        line: 0,
        evidence: `${name}@${deps[name]}`,
      })
    }
  }
  return out
}

/**
 * "Anything other than the agent moves work out of the box." A backend that
 * reads the sandbox filesystem, downloads from it, or syncs an out-directory.
 */
export function scanNoSandboxFilesystemReads(files: SourceFile[]): Violation[] {
  return scanLines(files, 'no-sandbox-filesystem-reads', [
    /\bfiles\s*\.\s*read\s*\(/,
    /\bfilesystem\s*\.\s*read\s*\(/,
    /\bdownloadFile\s*\(/,
    /\bdownload_file\s*\(/,
    /\bsandbox\s*\.\s*(?:files|filesystem|fs)\b[^\n]*\b(?:read|list|download|get)\b/,
    /\bsyncOut(?:put|Dir)?\s*\(/,
    /\bcollectArtifacts\s*\(/,
  ])
}

/**
 * "If somewhere in your code a third brand needs a third anything."
 *
 * Tenant names are supplied by the caller, discovered from the brains on disk,
 * so this scanner does not itself name a customer and picks up a third brand
 * automatically.
 */
export function scanNoTenantNames(files: SourceFile[], tenants: string[]): Violation[] {
  const terms = tenants.map((t) => t.trim()).filter((t) => t.length >= 3)
  if (terms.length === 0) return []
  const patterns = terms.map((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i'))
  return scanLines(files, 'no-tenant-names-in-source', patterns)
}

export interface SandboxLaunchPayload {
  /** Template or image identifier. */
  template?: string
  /** Human-facing name, if the provider takes one. */
  name?: string
  metadata?: Record<string, string>
  envs?: Record<string, string>
}

/**
 * "A Kahua box and an Emplifi box. Any box whose identity says which tenant or
 * task it serves."
 *
 * Identity is the template, the name, the metadata and the environment. The
 * hydration file may of course name a kit — that is data the box fetches and
 * reads. The box itself must boot knowing only an opaque run id.
 */
export function validateSandboxIdentity(
  payload: SandboxLaunchPayload,
  tenants: string[],
  kitIds: string[],
): Violation[] {
  const needles = [...tenants, ...kitIds].map((n) => n.trim()).filter((n) => n.length >= 3)
  const out: Violation[] = []

  const inspect = (where: string, value: string) => {
    for (const needle of needles) {
      if (new RegExp(escapeRegExp(needle), 'i').test(value)) {
        out.push({
          rule: 'no-tenant-in-sandbox-identity',
          file: where,
          line: 0,
          evidence: `${where} contains "${needle}": ${value}`,
        })
      }
    }
  }

  if (payload.template) inspect('template', payload.template)
  if (payload.name) inspect('name', payload.name)
  for (const [k, v] of Object.entries(payload.metadata ?? {})) {
    inspect(`metadata.${k}`, `${k}=${v}`)
  }
  for (const [k, v] of Object.entries(payload.envs ?? {})) {
    inspect(`envs.${k}`, `${k}=${v}`)
  }
  return out
}

/**
 * "Work that exists only on a box." A run that can reach a terminal success
 * state without a sandbox recorded, or artifacts with no durable location,
 * means state lived in the wrong place.
 */
export function validateRunsSchema(sql: string): Violation[] {
  const out: Violation[] = []
  const normalised = sql.replace(/\s+/g, ' ').toLowerCase()

  if (!/create table[^;]*\bruns\b/.test(normalised)) {
    out.push({
      rule: 'runs-schema',
      file: 'schema.sql',
      line: 0,
      evidence: 'no runs table found',
    })
    return out
  }
  if (!/sandbox_id[^,)]*not null/.test(normalised)) {
    out.push({
      rule: 'run-requires-sandbox',
      file: 'schema.sql',
      line: 0,
      evidence: 'runs.sandbox_id is not NOT NULL — a run could complete with no sandbox',
    })
  }
  if (!/create table[^;]*\bartifacts\b/.test(normalised)) {
    out.push({
      rule: 'artifacts-schema',
      file: 'schema.sql',
      line: 0,
      evidence: 'no artifacts table found',
    })
  } else if (!/storage_key[^,)]*not null/.test(normalised)) {
    out.push({
      rule: 'artifact-requires-durable-location',
      file: 'schema.sql',
      line: 0,
      evidence: 'artifacts.storage_key is not NOT NULL — an artifact could exist with no durable home',
    })
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
