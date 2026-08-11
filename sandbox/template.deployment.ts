import { Template } from 'e2b'

/**
 * The deployment sandbox.
 *
 * A separate template from generation, reached from a separate place, running as a
 * separate Postgres role. The asymmetry is the point: a box that can publish should
 * not be able to invent artifacts, and a box that can invent artifacts should not be
 * able to publish. Sharing one image would leave that separation resting on whichever
 * code path happened to create the box — which holds until someone adds a second
 * caller.
 *
 * Deploying is the brief's one automatic disqualifier, so this is also the narrower
 * of the two images: no image client, no font tooling, nothing that could produce
 * creative.
 */

const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.62.1-jammy'
const HOME = '/home/user'

export const deploymentTemplate = Template()
  .fromImage(PLAYWRIGHT_IMAGE)

  // ffmpeg because Playwright's video capture writes WebM through it. Without it
  // recording fails at close — which is the worst possible moment, since by then
  // the deploy has already happened and the evidence is what is missing.
  .aptInstall(['ca-certificates', 'ffmpeg', 'jq'])

  .setWorkdir(HOME)
  .makeDir([
    `${HOME}/artifacts`,
    `${HOME}/work/deploy`,
    `${HOME}/.claude/skills/deploy-campaign`,
  ])

  .copy('.staged/skills/deploy-campaign/SKILL.md', `${HOME}/.claude/skills/deploy-campaign/SKILL.md`)

  // The same executable as generation uses. One implementation, so durability
  // behaves identically in both boxes; the *policy* decides what each may write,
  // and this role may write only a recording.
  .copy('save_work.mjs', '/usr/local/bin/save_work')
  .runCmd('chmod +x /usr/local/bin/save_work')

  .copy('agent.deploy.ts', `${HOME}/agent.deploy.ts`)

  // `npm init -y` writes no `type`, so tsx compiles to CJS and every top-level
  // await in the agent fails to transform. Declared explicitly rather than left to
  // a default that only shows up as a build error inside a live box.
  .runCmd(`cd ${HOME} && npm init -y >/dev/null 2>&1 && npm pkg set type=module`)
  /**
   * What actually stops a deploy box regenerating creative — and what does not.
   *
   * This once claimed the image client was absent. It is not: `openai` is a hard
   * dependency of `@openai/agents`, so it arrives whether or not it is listed, and
   * `OPENAI_API_KEY` has to be present for the agent model at all. A box that wanted to
   * call the images API could.
   *
   * The real controls are elsewhere, and they are stronger than a missing package:
   * the deploy agent is given no image tool, and the `sandbox_deploy` role may insert
   * artifacts only with role `recording` or `result` — never `render`. So a box that
   * generated an image could not record it as the thing it published, which is the
   * property that actually matters. Provisioning is not the fence here; policy is.
   */
  .npmInstall([
    '@openai/agents@^0.14.3',
    'openai@^7.4.0',
    'playwright@1.62.1',
    'zod@^4.0.0',
    'tsx@^4.23.12',
  ])

  .setEnvs({
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    NODE_ENV: 'production',
    CQ_WORK_DIR: `${HOME}/work`,
    CQ_SANDBOX_KIND: 'deployment',
    // Recording destination, fixed here rather than left to the agent, because
    // `recording_required` in the hydration file has to point somewhere the
    // supervisor can find even if the agent never got that far.
    CQ_RECORDING_DIR: `${HOME}/work/deploy`,
  })

    /**
   * Make the runtime environment real.
   *
   * `setEnvs` writes build-time ENV, which a command session does not inherit —
   * verified in a live box, where `env | grep CQ_` came back empty and Chromium
   * then looked for itself in `~/.cache/ms-playwright` and failed. The image had
   * the browsers all along, at `/ms-playwright`.
   *
   * Two fixes rather than one, because they fail differently. The symlink works in
   * any shell, login or not, and needs nothing exported. The profile script covers
   * anything that reads the variable directly. Relying on the launcher to pass
   * `PLAYWRIGHT_BROWSERS_PATH` would make a template concern into a caller's
   * responsibility, and a caller that forgets produces a box that looks fine until
   * the first render.
   */
  .runCmd('mkdir -p /home/user/.cache && ln -sfn /ms-playwright /home/user/.cache/ms-playwright')
  // `runCmd` runs as `user`, which cannot write /etc — the first attempt failed
  // there. Elevated for exactly this step and dropped again immediately, so the
  // rest of the build has no more privilege than it needs.
  .setUser('root')
  .runCmd(
    'printf "export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright\\n' +
      'export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1\\n' +
      'export CQ_SANDBOX_KIND=deployment\\n' +
      'export CQ_WORK_DIR=/home/user/work\\n" > /etc/profile.d/cq-env.sh',
  )
  .runCmd('chmod 0644 /etc/profile.d/cq-env.sh')
  .runCmd('chown -R user:user /home/user/.cache')
  .setUser('user')

  .setReadyCmd('node -e "process.exit(0)"')
