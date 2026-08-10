// Extracts the source packet into eval/.packet/ so tests have real brains to
// read. Idempotent. The zips are committed; the extraction is not.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const out = resolve(here, '..', '.packet')

const zips = ['design-brains.zip', 'inspirations.zip', 'starter.zip']

mkdirSync(out, { recursive: true })

for (const zip of zips) {
  const src = join(repo, zip)
  if (!existsSync(src)) {
    console.error(`missing ${zip} in ${repo}`)
    process.exit(1)
  }
  execFileSync('unzip', ['-o', '-q', src, '-d', out], { stdio: 'inherit' })
}

console.log(`packet extracted to ${out}`)
