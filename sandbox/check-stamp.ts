/**
 * Recomputes the build stamp and reports whether the live templates match source.
 *
 * Imported by the launchers, which refuse to start a box on a mismatch, and runnable
 * directly to answer "do I need to rebuild?" without spending a build.
 *
 * Freshness is per template, not for the pair. One combined digest meant editing the
 * deploy agent refused a *generation* launch — two files that the generation image does
 * not contain, blocking work that could not possibly be affected by them. A guard that
 * stops correct work teaches people to pass `--allow-stale`, and then it is not a guard.
 *
 * So each template declares what it bakes, and a launch asks only about its own. The
 * lists below are the authority for both checking and building: `build.ts` imports them
 * rather than keeping a second copy, because two lists that must agree eventually will
 * not, and the failure is silent — a file baked into an image but absent from the stamp
 * never triggers a rebuild.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = import.meta.dirname
const REPO = join(ROOT, '..')

export type TemplateName = 'generation' | 'deployment'

const BAKED_TOOLKIT = [
  'capability.ts', 'png.ts', 'resample.ts', 'plate.ts', 'openai-image.ts',
  'brain.ts', 'campaign.ts', 'logo-placement.ts', 'overlay.ts', 'render.ts', 'checks.ts',
]

const sandboxFile = (name: string) => ({ label: name, path: join(ROOT, name) })
const skillFile = (name: string) => ({
  label: `skill:${name}`,
  path: join(REPO, '.claude', 'skills', name, 'SKILL.md'),
})

/**
 * What each image contains, read off the `.copy()` calls in its template.
 *
 * `save_work.mjs` is in both because both bake it, and a change to how work is saved
 * must invalidate both images. The toolkit is generation-only — the deployment template
 * copies no toolkit, because a deploy box has no business rendering anything.
 */
export const BAKED: Record<TemplateName, { label: string; path: string }[]> = {
  generation: [
    sandboxFile('agent.generate.ts'),
    sandboxFile('template.generation.ts'),
    sandboxFile('save_work.mjs'),
    skillFile('design-generation'),
    ...BAKED_TOOLKIT.map((file) => ({
      label: `toolkit:${file}`,
      path: join(REPO, 'eval', 'src', file),
    })),
  ],
  deployment: [
    sandboxFile('agent.deploy.ts'),
    sandboxFile('transcript.ts'),
    sandboxFile('template.deployment.ts'),
    sandboxFile('save_work.mjs'),
    skillFile('deploy-campaign'),
  ],
}

const fileDigest = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)

/** Every baked file's digest, labelled, across both templates. */
export function digestFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of [...BAKED.generation, ...BAKED.deployment]) {
    files[entry.label] ??= fileDigest(entry.path)
  }
  return files
}

/** One template's digest, over only the files that template bakes. */
export function templateDigest(which: TemplateName, files = digestFiles()): string {
  const combined = BAKED[which]
    .map((entry) => entry.label)
    .sort()
    .map((label) => `${label}:${files[label]}`)
    .join('\n')
  return createHash('sha256').update(combined).digest('hex')
}

export interface StampCheck {
  fresh: boolean
  reason: string
  changed: string[]
}

interface Stamp {
  digests?: Partial<Record<TemplateName, string>>
  built: string[]
  at: string
  files: Record<string, string>
}

/**
 * Whether the live image for `which` still matches source.
 *
 * Called with no argument it answers for both, which is what the CLI wants — someone
 * asking "do I need to rebuild?" means either image.
 */
export function checkStamp(which?: TemplateName): StampCheck {
  const stampPath = join(ROOT, '.build-stamp.json')
  if (!existsSync(stampPath)) {
    return {
      fresh: false,
      reason: 'no .build-stamp.json — the templates have never been built from this tree',
      changed: [],
    }
  }
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as Stamp
  const targets: TemplateName[] = which ? [which] : ['generation', 'deployment']
  const files = digestFiles()

  // A stamp written before this file was split has no per-template digests. Treated as
  // stale rather than assumed good: the honest answer to "was this image built from a
  // list I cannot see" is no.
  if (!stamp.digests) {
    return {
      fresh: false,
      reason: `the build stamp predates per-template digests (written ${stamp.at})`,
      changed: [],
    }
  }

  if (targets.every((name) => stamp.digests?.[name] === templateDigest(name, files))) {
    return {
      fresh: true,
      reason: `${targets.join(' and ')} match source (built ${stamp.at})`,
      changed: [],
    }
  }

  // Name the files that moved, and only the ones this launch cares about. "Something
  // changed" sends someone hunting; a list scoped to the image being started tells them
  // immediately whether it matters to them.
  const changed = targets
    .flatMap((name) => BAKED[name])
    .filter((entry) => stamp.files[entry.label] !== files[entry.label])
    .map((entry) => entry.label)

  return {
    fresh: false,
    reason:
      `${new Set(changed).size} baked file(s) changed since the last build (${stamp.at})` +
      (which ? ` — checking the ${which} image only` : ''),
    changed: [...new Set(changed)],
  }
}

if (process.argv[1]?.endsWith('check-stamp.ts')) {
  let stale = false
  for (const name of ['generation', 'deployment'] as TemplateName[]) {
    const result = checkStamp(name)
    console.log(result.fresh ? `FRESH  ${name} — ${result.reason}` : `STALE  ${name} — ${result.reason}`)
    for (const c of result.changed) console.log(`         changed: ${c}`)
    if (!result.fresh) stale = true
  }
  if (stale) console.log('\n  run: npm run build --prefix sandbox\n')
  process.exit(stale ? 1 : 0)
}
