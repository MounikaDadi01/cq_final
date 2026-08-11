import { Template } from 'e2b'

/**
 * The generation sandbox.
 *
 * Everything here is the *baked* hydration lifetime: identical for every customer
 * and every run. Nothing brand-specific belongs in this image — a font, a logo or a
 * palette baked in would be a customer compiled into infrastructure, and a third
 * brand would need a rebuild. Brand files arrive per run from the `brains` bucket.
 *
 * Built on E2B's Build System 2.0, so the build runs on E2B's servers rather than
 * requiring Docker locally. That matters less for convenience than for provenance:
 * the template comes from code in the repo, reproducibly, and CI can rebuild it
 * without a machine-specific toolchain.
 */

/**
 * Pinned to a Playwright release image.
 *
 * Chromium and its ~90 shared libraries come pre-installed and version-matched to
 * the Playwright client, which is the failure this avoids: a browser that launches
 * but renders text differently, or refuses to start over a missing `libnss3`, in a
 * box that only lives twenty minutes. The tag is pinned rather than floating so a
 * render today and a render next month lay out identically — an ad pipeline whose
 * output shifts with an upstream base image is not reproducible.
 */
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.62.1-jammy'

const HOME = '/home/user'

export const generationTemplate = Template()
  .fromImage(PLAYWRIGHT_IMAGE)

  // fontconfig so a font written to disk at run time can be registered and found
  // by Chromium. The render also loads faces through `@font-face` with `file://`
  // URLs, which is belt and braces on purpose: a browser silently substitutes a
  // missing family, the ad still looks fine, and the typeface is wrong.
  .aptInstall(['fontconfig', 'ca-certificates', 'jq'])

  .setWorkdir(HOME)
  .makeDir([
    `${HOME}/brain`,
    `${HOME}/inspirations`,
    `${HOME}/work`,
    `${HOME}/parent`,
    `${HOME}/.fonts`,
    `${HOME}/.claude/skills/design-generation`,
  ])

  // The contract, as a skill the agent invokes — the same bytes a developer
  // invokes locally. Baked rather than fetched: identical every run, so a per-run
  // download would add a failure mode for no benefit.
  .copy('.staged/skills/design-generation/SKILL.md', `${HOME}/.claude/skills/design-generation/SKILL.md`)

  // The only thing that moves work out of the box. A plain script, on PATH, so a
  // developer with a shell in a live box can read exactly what leaves and where.
  .copy('save_work.mjs', '/usr/local/bin/save_work')
  .runCmd('chmod +x /usr/local/bin/save_work')

  // The tested deterministic half, and the agent that drives it.
  .copy('.staged/toolkit', `${HOME}/toolkit`)
  .copy('agent.generate.ts', `${HOME}/agent.generate.ts`)

  // Agent and image client. No brand packages, nothing customer-shaped.
  // `tsx` so the box runs the same TypeScript the test suite runs, rather than a
  // build artifact that could differ from what was tested.
  // `npm init -y` writes no `type`, so tsx compiles to CJS and every top-level
  // await in the agent fails to transform. Declared explicitly rather than left to
  // a default that only shows up as a build error inside a live box.
  .runCmd(`cd ${HOME} && npm init -y >/dev/null 2>&1 && npm pkg set type=module`)
  .npmInstall([
    'openai@^7.4.0',
    '@openai/agents@^0.14.3',
    'playwright@1.62.1',
    'pngjs@^7.0.0',
    'zod@^4.0.0',
    'tsx@^4.23.12',
  ])

  .setEnvs({
    // Chromium is already in the image; stop the client re-downloading it into a
    // box that will be destroyed in minutes.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    NODE_ENV: 'production',
    CQ_WORK_DIR: `${HOME}/work`,
    CQ_SANDBOX_KIND: 'generation',
    // Deliberately absent, and worth stating: no OPENAI_API_KEY, no run token, no
    // Supabase URL. Those are per-run values set on the sandbox at creation. A key
    // baked into a template would be in the image for every tenant that ever used
    // it.
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
      'export CQ_SANDBOX_KIND=generation\\n' +
      'export CQ_WORK_DIR=/home/user/work\\n" > /etc/profile.d/cq-env.sh',
  )
  .runCmd('chmod 0644 /etc/profile.d/cq-env.sh')
  .runCmd('chown -R user:user /home/user/.cache')
  .setUser('user')
  // Fonts arriving at run time need registering once before the first render.
  .runCmd('fc-cache -f >/dev/null 2>&1 || true')

  .setReadyCmd('node -e "process.exit(0)"')
