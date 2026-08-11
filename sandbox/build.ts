/**
 * Builds the sandbox templates on E2B's infrastructure.
 *
 *   npm run build              # both
 *   npm run build:generation
 *   npm run build:deployment
 *   npm run dockerfile         # print the equivalent Dockerfiles, build nothing
 *
 * `--print` exists because a template defined in code is harder to review than a
 * Dockerfile at a glance, and this is the image a customer's brand will be rendered
 * inside. Being able to read it without spending a build is worth the few lines.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Template, type LogEntry } from 'e2b'
import { digestFiles, templateDigest } from './check-stamp'
import { generationTemplate } from './template.generation'
import { deploymentTemplate } from './template.deployment'

const ROOT = import.meta.dirname
const REPO = join(ROOT, '..')

/**
 * Skills the templates bake in, staged into the build context before building.
 *
 * E2B refuses a copy source containing `..` — "path escapes the context
 * directory" — so a template cannot reach up to the repo's `.claude/skills/`.
 * Staging is the answer, but a copy is a second source of truth, and the failure
 * mode is the quiet one: an image baking last week's contract while the repo has
 * this week's, with nothing to say so.
 *
 * So the copy is made fresh on every build and then asserted byte-identical. The
 * check is cheap and it converts "we remembered to re-stage" into something the
 * build proves.
 */
const BAKED_SKILLS = ['design-generation', 'deploy-campaign'] as const

/**
 * The deterministic half of the pipeline, staged into the box.
 *
 * These modules already exist and are covered by 295 tests: the size arithmetic
 * that keeps a canvas legal, the resampler, the overlay builder, the Playwright
 * render with font verification, and the checks. Re-implementing any of it inside
 * a prompt would mean the box and the test suite disagree about what "correct"
 * means, and the box would be the one nobody can run offline.
 *
 * So the agent gets tools that call tested code. Judgement stays with the model —
 * composition, copy, which logo reads on which ground — and arithmetic stays with
 * the arithmetic.
 *
 * Staged rather than published as a package because this is a trial repo, and a
 * digest check gives the same protection against drift as a version number would.
 */
const BAKED_TOOLKIT = [
  'capability.ts',
  'png.ts',
  'resample.ts',
  'plate.ts',
  'openai-image.ts',
  'brain.ts',
  'campaign.ts',
  'logo-placement.ts',
  'overlay.ts',
  'render.ts',
  'checks.ts',
] as const

/**
 * Both templates are defined in this directory rather than a `templates/`
 * subdirectory, and that is load-bearing rather than untidy.
 *
 * E2B resolves a copy source relative to the file that *defines* the template, and
 * refuses any path containing `..`. Definitions one level down therefore resolved
 * `.staged/` and `save_work.mjs` against the wrong directory and the build failed
 * with "No files found" — after the remote build had already started. Keeping the
 * definitions beside the files they copy makes the context the same directory a
 * reader is looking at.
 */

function stageSkills(): void {
  for (const name of BAKED_SKILLS) {
    const from = join(REPO, '.claude', 'skills', name, 'SKILL.md')
    const to = join(ROOT, '.staged', 'skills', name, 'SKILL.md')
    mkdirSync(join(ROOT, '.staged', 'skills', name), { recursive: true })
    copyFileSync(from, to)

    const source = readFileSync(from)
    const staged = readFileSync(to)
    if (!source.equals(staged)) {
      throw new Error(`staged skill ${name} differs from the repo copy`)
    }

    // A skill whose declared name does not match its directory is invokable by a
    // name nothing uses, and the agent proceeds without the contract rather than
    // failing.
    const declared = /^name:\s*(\S+)/m.exec(source.toString('utf8'))?.[1]
    if (declared !== name) {
      throw new Error(`skill in ${name}/ declares name "${declared}"`)
    }

    console.log(`   staged skill ${name} (${source.length} bytes)`)
  }
}

function stageToolkit(): void {
  const dest = join(ROOT, '.staged', 'toolkit')
  mkdirSync(dest, { recursive: true })
  let total = 0
  for (const file of BAKED_TOOLKIT) {
    const from = join(REPO, 'eval', 'src', file)
    const to = join(dest, file)
    copyFileSync(from, to)
    const source = readFileSync(from)
    if (!source.equals(readFileSync(to))) {
      throw new Error(`staged toolkit ${file} differs from the repo copy`)
    }
    total += source.length
  }
  console.log(`   staged toolkit: ${BAKED_TOOLKIT.length} modules, ${(total / 1024).toFixed(0)} KB`)
}

/**
 * A digest of everything the templates bake in, written after a successful build.
 *
 * This exists because of a failure I caused twice: editing the agent, forgetting to
 * rebuild, and launching against a stale image. The first symptom was
 * `ERR_MODULE_NOT_FOUND` for a file that plainly existed on disk — which reads as a
 * path bug, not a staleness bug, and cost a run each time to work out.
 *
 * The launcher recomputes this and refuses to start a box when it disagrees. A
 * comment reminding someone to rebuild would not have helped; I wrote the code and
 * still forgot.
 */
const STAMP = join(ROOT, '.build-stamp.json')

/**
 * One digest per template, over the file lists in `check-stamp.ts`.
 *
 * The lists are imported rather than repeated. This function used to hold its own copy,
 * and a second copy of a list that must match the first is a bug waiting for someone to
 * add a file to one of them — an image would bake a file the stamp never watched, and no
 * edit to it would ever trigger a rebuild.
 */
export function writeStamp(built: string[]): void {
  const files = digestFiles()
  const digests = {
    generation: templateDigest('generation', files),
    deployment: templateDigest('deployment', files),
  }
  writeFileSync(
    STAMP,
    JSON.stringify({ digests, built, at: new Date().toISOString(), files }, null, 2) + '\n',
  )
  for (const [name, digest] of Object.entries(digests)) {
    console.log(`   stamped ${name} ${digest.slice(0, 12)}`)
  }
}

/** Read from the repo's own .env so there is one place keys live. */
function readEnvFile(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(join(ROOT, '..', '.env'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
        }),
    )
  } catch {
    return {}
  }
}

const env = { ...readEnvFile(), ...process.env }

/**
 * Template names carry no tenant and no task.
 *
 * A box identity spelling out a customer or a campaign would be a disqualifier on
 * its own, and template aliases are the most tempting place to leak one — they are
 * human-facing and it feels helpful. They describe the *kind* of box only.
 */
const TEMPLATES = {
  generation: { alias: 'cq-generation', template: generationTemplate },
  deployment: { alias: 'cq-deployment', template: deploymentTemplate },
} as const

type Which = keyof typeof TEMPLATES

const args = process.argv.slice(2)
const printOnly = args.includes('--print')
const requested = args.find((a) => !a.startsWith('--')) ?? 'all'

async function printDockerfiles() {
  stageSkills()
  stageToolkit()
  for (const [name, { alias, template }] of Object.entries(TEMPLATES)) {
    console.log(`\n${'='.repeat(70)}`)
    console.log(`${name}  (alias: ${alias})`)
    console.log('='.repeat(70))
    console.log(await Template.toDockerfile(template))
  }
}

async function build(which: Which) {
  const { alias, template } = TEMPLATES[which]
  console.log(`\n── building ${which} as "${alias}"`)

  const started = Date.now()
  await Template.build(template, alias, {
    // Streams build output, so a failure names the step that failed rather than
    // surfacing as a template that merely does not exist.
    onBuildLogs: (entry: LogEntry) => console.log(`   ${entry.message ?? JSON.stringify(entry)}`),
  })

  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  console.log(`   built in ${seconds}s`)

  // Existence is confirmed rather than inferred from a successful call, for the
  // same reason save_work reads back its own row: "the request returned 200" is a
  // weaker claim than "the thing is there".
  const exists = await Template.exists(alias)
  console.log(`   exists on E2B: ${exists}`)
  if (!exists) throw new Error(`${alias} reported built but does not exist`)
}

async function main() {
  if (printOnly) {
    await printDockerfiles()
    return
  }

  if (!env.E2B_API_KEY) throw new Error('E2B_API_KEY missing — add it to .env')
  process.env.E2B_API_KEY = env.E2B_API_KEY

  stageSkills()
  stageToolkit()

  const targets: Which[] =
    requested === 'all' ? (Object.keys(TEMPLATES) as Which[]) : [requested as Which]

  for (const t of targets) {
    if (!TEMPLATES[t]) throw new Error(`unknown template "${t}"`)
  }

  for (const t of targets) await build(t)

  // Only after every build succeeded. A stamp written on a partial build would
  // claim the images match sources they do not.
  writeStamp(targets)

  console.log(`\n${targets.length} template(s) built.\n`)
}

main().catch((error) => {
  console.error(`\nbuild failed: ${error.message}\n`)
  process.exit(1)
})
