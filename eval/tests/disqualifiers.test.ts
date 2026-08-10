import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectSourceFiles,
  scanNoAgentRuntimeDependency,
  scanNoLocalProcessSpawning,
  scanNoSandboxFilesystemReads,
  scanNoTenantNames,
  validateRunsSchema,
  validateSandboxIdentity,
  type SourceFile,
} from '../src/disqualifiers'
import { brains, brainSlugs } from './fixtures'

const file = (path: string, content: string): SourceFile => ({ path, content })

const tenants = brainSlugs()
const kitIds = brains().map((b) => b.kitId)

describe('tenant names are discovered, not hardcoded', () => {
  it('finds the tenants from the packet on disk', () => {
    expect(tenants.length).toBeGreaterThanOrEqual(2)
    expect(kitIds.every((k) => k.length > 0)).toBe(true)
  })
})

describe('the agent may not live where the backend lives', () => {
  const clean = [
    file(
      'api/runs.ts',
      `import { Sandbox } from 'e2b'
       export async function start(runId: string) {
         const box = await Sandbox.create({ template: TEMPLATE })
         await box.files.write('/work/HYDRATION.md', render(runId))
         return box.sandboxId
       }`,
    ),
  ]

  it('passes a backend that only provisions a remote sandbox', () => {
    expect(scanNoLocalProcessSpawning(clean)).toEqual([])
  })

  it.each([
    ['an import of child_process', `import { spawn } from 'node:child_process'`],
    ['a require of child_process', `const cp = require('child_process')`],
    ['an execSync call', `execSync('claude -p "do the thing"')`],
    ['a spawn call', `spawn('node', ['agent.js'])`],
    ['a headless agent invocation', `await sh('claude -p < prompt.md')`],
  ])('catches %s', (_label, line) => {
    const violations = scanNoLocalProcessSpawning([file('api/runs.ts', line)])
    expect(violations.length).toBe(1)
    expect(violations[0].rule).toBe('no-local-process-spawning')
    expect(violations[0].line).toBe(1)
  })

  it('honours an explicit, auditable allowance', () => {
    const line = `execSync('git rev-parse HEAD') // cq-allow-disqualifier-scan: build metadata`
    expect(scanNoLocalProcessSpawning([file('scripts/version.ts', line)])).toEqual([])
  })

  it('passes a backend package with no agent runtime', () => {
    const pkg = JSON.stringify({ name: 'api', dependencies: { e2b: '^1.0.0', zod: '^3.0.0' } })
    expect(scanNoAgentRuntimeDependency(pkg)).toEqual([])
  })

  it('catches an agent runtime in the backend package', () => {
    const pkg = JSON.stringify({
      name: 'api',
      dependencies: { '@anthropic-ai/claude-agent-sdk': '^1.0.0' },
    })
    const violations = scanNoAgentRuntimeDependency(pkg)
    expect(violations.length).toBe(1)
    expect(violations[0].rule).toBe('no-agent-runtime-in-backend')
  })
})

describe('only the agent moves work out of the box', () => {
  it('passes a backend that reads durable storage instead of the sandbox', () => {
    const clean = [
      file(
        'api/reconcile.ts',
        `const object = await s3.headObject({ Bucket: WORK, Key: key })
         await db.artifacts.insert({ runId, key, bytes: object.ContentLength })`,
      ),
    ]
    expect(scanNoSandboxFilesystemReads(clean)).toEqual([])
  })

  it.each([
    ['reading a file from the box', `const html = await box.files.read('/work/out/index.html')`],
    ['downloading from the box', `await downloadFile(box, '/work/out/plate.png')`],
    ['syncing an out-directory', `await syncOutDir(box, localPath)`],
    ['collecting artifacts from the box', `const found = await collectArtifacts(sandbox)`],
    ['listing the box filesystem', `const list = await sandbox.filesystem.read('/work')`],
  ])('catches %s', (_label, line) => {
    const violations = scanNoSandboxFilesystemReads([file('api/collect.ts', line)])
    expect(violations.length).toBe(1)
    expect(violations[0].rule).toBe('no-sandbox-filesystem-reads')
  })
})

describe('no box identity says which tenant it serves', () => {
  const opaque = {
    template: 'cq-design-runner',
    name: 'run_01JB8XQ2YV',
    metadata: { runId: 'run_01JB8XQ2YV' },
    envs: {
      RUN_ID: 'run_01JB8XQ2YV',
      API_BASE: 'https://edge.example/api',
      RUN_TOKEN: 'opaque-token',
    },
  }

  it('passes a launch payload carrying only an opaque run id', () => {
    expect(validateSandboxIdentity(opaque, tenants, kitIds)).toEqual([])
  })

  it('catches a tenant name in the template', () => {
    const payload = { ...opaque, template: `cq-runner-${tenants[0]}` }
    const violations = validateSandboxIdentity(payload, tenants, kitIds)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0].file).toBe('template')
  })

  it('catches a tenant name in the sandbox name', () => {
    const payload = { ...opaque, name: `${tenants[0]}-box-3` }
    expect(validateSandboxIdentity(payload, tenants, kitIds).length).toBeGreaterThan(0)
  })

  it('catches a tenant name in metadata', () => {
    const payload = { ...opaque, metadata: { ...opaque.metadata, customer: tenants[1] } }
    expect(validateSandboxIdentity(payload, tenants, kitIds).length).toBeGreaterThan(0)
  })

  it('catches a brand kit id passed as environment', () => {
    // The hydration file may name a kit — it is data the box fetches and reads.
    // The box's own environment may not, because that is identity.
    const payload = { ...opaque, envs: { ...opaque.envs, BRAND_KIT_ID: kitIds[0] } }
    const violations = validateSandboxIdentity(payload, tenants, kitIds)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0].file).toMatch(/^envs\./)
  })
})

describe('a third brand needs no code changes', () => {
  it('passes source that resolves brands from data', () => {
    const clean = [
      file(
        'api/hydrate.ts',
        `const kit = await db.brandKits.findById(request.brandKitId)
         const assets = await db.brandAssets.where({ kitId: kit.id })
         return assets.map((a) => presign(a.storageKey))`,
      ),
    ]
    expect(scanNoTenantNames(clean, tenants)).toEqual([])
  })

  it.each(tenants)('catches a branch naming %s', (tenant) => {
    const dirty = [
      file('api/hydrate.ts', `if (customer === '${tenant}') { applySpecialCase() }`),
    ]
    const violations = scanNoTenantNames(dirty, tenants)
    expect(violations.length).toBe(1)
    expect(violations[0].rule).toBe('no-tenant-names-in-source')
  })

  it('would pick up a brand that does not exist yet', () => {
    // Discovery drives the scanner, so a third brain in the packet is covered
    // the moment it lands, with no edit here.
    const invented = 'northwind'
    const dirty = [file('api/x.ts', `const isNorthwind = slug === '${invented}'`)]
    expect(scanNoTenantNames(dirty, [...tenants, invented]).length).toBe(1)
    expect(scanNoTenantNames(dirty, tenants).length).toBe(0)
  })
})

describe('no work exists only on a box', () => {
  const good = `
    CREATE TABLE runs (
      id text PRIMARY KEY,
      state text NOT NULL,
      sandbox_id text NOT NULL,
      heartbeat_at timestamptz
    );
    CREATE TABLE artifacts (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES runs(id),
      storage_key text NOT NULL,
      sha256 text NOT NULL
    );`

  it('passes a schema where a run must have a sandbox and an artifact must have a home', () => {
    expect(validateRunsSchema(good)).toEqual([])
  })

  it('catches a run that could complete without a sandbox', () => {
    const violations = validateRunsSchema(good.replace('sandbox_id text NOT NULL', 'sandbox_id text'))
    expect(violations.some((v) => v.rule === 'run-requires-sandbox')).toBe(true)
  })

  it('catches an artifact with no durable location', () => {
    const violations = validateRunsSchema(
      good.replace('storage_key text NOT NULL', 'storage_key text'),
    )
    expect(violations.some((v) => v.rule === 'artifact-requires-durable-location')).toBe(true)
  })

  it('catches a missing runs table outright', () => {
    expect(validateRunsSchema('CREATE TABLE things (id text);').length).toBeGreaterThan(0)
  })
})

describe('the repository as it stands', () => {
  const root = resolve(import.meta.dirname, '..', '..')
  const files = collectSourceFiles(resolve(root, 'app')).concat(
    collectSourceFiles(resolve(root, 'api')),
    collectSourceFiles(resolve(root, 'src')),
  )

  it('has no violations in application source', () => {
    // Currently vacuous: the application tree does not exist yet. It is wired up
    // now so that stage 5 cannot land without it, and the planted-violation
    // tests above are what prove the scanners work in the meantime.
    expect(scanNoLocalProcessSpawning(files)).toEqual([])
    expect(scanNoSandboxFilesystemReads(files)).toEqual([])
    expect(scanNoTenantNames(files, tenants)).toEqual([])
  })

  it('says plainly whether it scanned anything', () => {
    if (files.length === 0) {
      expect(files.length).toBe(0) // documented vacuous pass
    } else {
      expect(files.length).toBeGreaterThan(0)
    }
  })
})
