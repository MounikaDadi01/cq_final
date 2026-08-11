/**
 * Smoke test: does a freshly created box actually contain what the template claims?
 *
 * `Template.exists()` says a build succeeded. It does not say the skill landed at
 * the path the hydration file will point at, or that Chromium launches, or that
 * save_work is executable. Those are the things a run depends on and they fail
 * silently — a missing skill means the agent proceeds without the contract.
 */
import { readFileSync } from 'node:fs'
import { Sandbox } from 'e2b'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)
process.env.E2B_API_KEY = env.E2B_API_KEY

const which = process.argv[2] ?? 'generation'
const alias = which === 'deployment' ? 'cq-deployment' : 'cq-generation'
const skill = which === 'deployment' ? 'deploy-campaign' : 'design-generation'

const checks: { label: string; cmd: string; expect: RegExp }[] = [
  {
    label: 'skill is at the path hydration points at',
    cmd: `grep -m1 '^name:' /home/user/.claude/skills/${skill}/SKILL.md`,
    expect: new RegExp(`name:\\s*${skill}`),
  },
  { label: 'save_work is on PATH and executable', cmd: 'test -x "$(which save_work)" && echo yes', expect: /yes/ },
  { label: 'save_work refuses without env', cmd: 'save_work --dry-run 2>&1 | head -1; true', expect: /is not set/ },
  { label: 'openai client present', cmd: 'node -e "console.log(require(\'/home/user/node_modules/openai/package.json\').version)"', expect: /^\d+\./ },
  { label: 'agents sdk present', cmd: 'node -e "console.log(require(\'/home/user/node_modules/@openai/agents/package.json\').version)"', expect: /^\d+\./ },
  { label: 'chromium launches', cmd: 'node -e "const{chromium}=require(\'/home/user/node_modules/playwright\');chromium.launch().then(async b=>{console.log(b.version());await b.close()})"', expect: /\d+\./ },
  // Sourced explicitly: E2B command sessions are not login shells, so profile.d is
  // not read automatically. The launcher passes per-run env anyway; this asserts
  // the template's own defaults are correct and available to anything that looks.
  {
    label: 'template env available via profile.d',
    cmd: '. /etc/profile.d/cq-env.sh && echo $CQ_SANDBOX_KIND',
    expect: new RegExp(which),
  },
  {
    label: 'browser path resolves without any env set',
    cmd: 'readlink -f /home/user/.cache/ms-playwright',
    expect: /^\/ms-playwright$/,
  },
  { label: 'no service_role key baked in', cmd: 'env | grep -c SERVICE_ROLE || true', expect: /^0$/ },
  { label: 'no openai key baked in', cmd: 'env | grep -c OPENAI_API_KEY || true', expect: /^0$/ },
]

const sbx = await Sandbox.create(alias, { timeoutMs: 180_000 })
console.log(`\n${alias}  sandbox ${sbx.sandboxId}\n`)

let failed = 0
for (const check of checks) {
  const result = await sbx.commands
    .run(check.cmd, { timeoutMs: 90_000 })
    .catch((e: unknown) => ({ stdout: '', stderr: String(e).slice(0, 160), exitCode: 1 }))
  const output = `${result.stdout}${result.stderr}`.trim().split('\n').pop() ?? ''
  const ok = check.expect.test(output)
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${check.label.padEnd(44)} ${output.slice(0, 44)}`)
}

await sbx.kill()
console.log(`\n${checks.length - failed}/${checks.length} passed, box killed\n`)
process.exit(failed ? 1 : 0)
