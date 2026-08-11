/**
 * The deployment agent. Runs inside the deploy box, and is the only thing that does.
 *
 * It drives someone else's interface, which makes it different from the generation
 * agent in one important way: **there is no undo out there.** A half-created campaign
 * has to be found by a person before it can be removed, so the bias throughout is to
 * stop rather than guess.
 *
 * The division of labour again:
 *
 *   deterministic — download the artifacts, verify their bytes, start the recording,
 *                   read back the result, save. All failure-checked in code.
 *   judgement     — reading a page and deciding which control does what. The interface
 *                   is not ours and can change, so a recorded click path is a
 *                   description of one past visit, not a rule about this one.
 *
 * The recording is not a nicety. Playwright flushes video on context close, so a box
 * killed first loses it — and a deploy with no recording cannot be evidenced. Context
 * close therefore happens before the run reports anything.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Agent, run, tool } from '@openai/agents'
import { chromium, type BrowserContext, type Locator, type Page } from 'playwright'
import { z } from 'zod'
import { Transcript } from './transcript'

const HOME = process.env.HOME ?? '/home/user'
const WORK = process.env.CQ_WORK_DIR ?? join(HOME, 'work')
const RECORDING_DIR = process.env.CQ_RECORDING_DIR ?? join(WORK, 'deploy')
const ARTIFACT_DIR = join(HOME, 'artifacts')
const MODEL = process.env.CQ_AGENT_MODEL ?? 'gpt-5.6-sol'

interface DeployHydration {
  kind: 'deploy'
  run_id: string
  revision_id: string
  brand_kit_id: string
  publish: {
    canvas: string
    relative_path: string
    signed_url: string
    /** What the launcher says it weighs. A download that disagrees is a blocker. */
    bytes: number
    width: number
    height: number
  }[]
  campaign: { name: string; copy: Record<string, string | null> }
  target: {
    tool: string
    entry_url: string
    credential_env: string[]
    /** The tool's own campaign to attach to. Null means stop rather than guess. */
    campaign: string | null
    objective: string | null
    notes: string | null
    /** Whatever else the tool's form asks for. Absent values are a reason to stop. */
    fields: Record<string, string>
  }
  skill: { invoke: string; mount: { path: string } }
  resolution_order: string[]
  outputs: { root: string; save_with: string; recording_required: true; expected_tree: string[] }
  limits: { sandbox_timeout_seconds: number }
}

const hydration: DeployHydration = JSON.parse(readFileSync(join(HOME, 'hydration.json'), 'utf8'))
const skillBody = readFileSync(hydration.skill.mount.path, 'utf8')

mkdirSync(ARTIFACT_DIR, { recursive: true })
mkdirSync(RECORDING_DIR, { recursive: true })

const findings: { code: string; severity: string; detail: string }[] = []
const steps: string[] = []

/**
 * The run's account of itself, made durable every thirty seconds.
 *
 * `steps` already existed but only reached storage in `RESULT.json` at the very end, so
 * the runs most worth reading — the ones killed mid-form — left nothing behind. This
 * writes the same events as they happen.
 *
 * Constructed but not started until the browser is up: a failure before then is already
 * reported by the launcher, and a timer with nothing to say is noise.
 */
const transcript = new Transcript({
  workDir: WORK,
  runId: hydration.run_id,
})

function note(step: string) {
  steps.push(`${new Date().toISOString().slice(11, 19)} ${step}`)
  console.log(`[deploy] ${step}`)
  transcript.line('step', { step })
}

/**
 * Downloads every artifact and checks its size against the manifest.
 *
 * Done before the browser opens, because an artifact that will not download is a
 * blocker at the cheapest possible moment — before anything has been created in
 * someone else's account.
 */
async function fetchArtifacts() {
  const local: { canvas: string; path: string; bytes: number; digest: string }[] = []
  for (const item of hydration.publish) {
    const response = await fetch(item.signed_url)
    if (!response.ok) {
      throw new Error(`could not download ${item.relative_path}: ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    /**
     * The manifest check the skill has always asked for.
     *
     * A truncated fetch produces a valid PNG header and a short file, which uploads
     * without complaint and renders as a half-drawn ad. Cheaper to catch here than in
     * someone's live campaign.
     */
    if (item.bytes && bytes.length !== item.bytes) {
      throw new Error(
        `${item.relative_path} downloaded ${bytes.length}B, manifest says ${item.bytes}B`,
      )
    }
    const path = join(ARTIFACT_DIR, `${item.canvas}.png`)
    writeFileSync(path, bytes)
    local.push({
      canvas: item.canvas,
      path,
      bytes: bytes.length,
      digest: createHash('sha256').update(bytes).digest('hex'),
    })
    note(`downloaded ${item.canvas} · ${bytes.length}B · ${item.width}x${item.height}`)
  }
  if (local.length === 0) throw new Error('nothing to publish')
  return local
}

const artifacts = await fetchArtifacts()

/**
 * A recording context, opened before the first navigation.
 *
 * `recordVideo` writes on close, so nothing here is optional and nothing may be
 * reordered: browser, then context with video, then any page at all.
 */
let context: BrowserContext | null = null
let page: Page | null = null

const browser = await chromium.launch()
context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: RECORDING_DIR, size: { width: 1440, height: 900 } },
})
page = await context.newPage()
note('recording started')
// Flushing starts here: from this point the box is driving somebody else's interface,
// which is the only part of a deploy anybody needs a transcript of.
transcript.start()

const currentPage = () => page as Page

/** What is on screen, as text the model can reason about. */
const readTool = tool({
  name: 'read_page',
  description:
    'Return the current URL, the visible text, and every interactive control with its ' +
    'name and label. Call this after every navigation — the interface is not ours and ' +
    'a remembered layout is not a reliable one.',
  parameters: z.object({}),
  async execute() {
    const p = currentPage()
    await p.waitForLoadState('domcontentloaded').catch(() => {})
    const controls: string[] = []
    for (const el of await p.locator('input, select, textarea, button, a[href]').all()) {
      const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '?')
      const type = await el.getAttribute('type')
      const name = await el.getAttribute('name')
      const href = await el.getAttribute('href')
      const placeholder = await el.getAttribute('placeholder')
      /**
       * `value`, `id`, `checked` and the associated label text.
       *
       * Without these a radio group is invisible. Three
       * `input[type=radio][name="objective"]` elements have no inner text, no
       * placeholder and the same name, so they rendered as three identical lines and
       * the agent stopped rather than guess which one meant "Awareness" — correctly,
       * but for a reason that was ours rather than the tool's.
       *
       * The label is looked up two ways because forms do it both ways: a `<label for>`
       * elsewhere in the document, or a `<label>` wrapping the input.
       */
      const value = await el.getAttribute('value')
      const id = await el.getAttribute('id')
      const checked = await el.evaluate((n) => (n as HTMLInputElement).checked ?? null).catch(() => null)
      const disabled = await el.evaluate((n) => (n as HTMLInputElement).disabled ?? false).catch(() => false)
      const labelled = await el
        .evaluate((n) => {
          const self = n as HTMLInputElement
          if (self.id) {
            const forLabel = document.querySelector(`label[for="${self.id}"]`)
            if (forLabel?.textContent?.trim()) return forLabel.textContent.trim()
          }
          return n.closest('label')?.textContent?.trim() ?? ''
        })
        .catch(() => '')
      const inner = (await el.innerText().catch(() => '')).trim()
      const label = (inner || labelled).slice(0, 48)

      // Options, so a select is choosable without a second call to discover them.
      const options =
        tag === 'select'
          ? await el
              .evaluate((n) => [...(n as HTMLSelectElement).options].map((o) => o.value))
              .catch(() => [])
          : []

      controls.push(
        `${tag}${type ? `[${type}]` : ''}` +
          `${name ? ` name="${name}"` : ''}` +
          `${value !== null ? ` value="${value}"` : ''}` +
          `${id ? ` id="${id}"` : ''}` +
          `${placeholder ? ` placeholder="${placeholder}"` : ''}` +
          `${label ? ` text="${label}"` : ''}` +
          `${checked === true ? ' checked' : ''}` +
          `${disabled ? ' DISABLED' : ''}` +
          `${options.length ? ` options=[${options.join('|')}]` : ''}` +
          `${href ? ` href="${href}"` : ''}`,
      )
    }
    return {
      url: p.url(),
      title: await p.title(),
      text: (await p.locator('body').innerText().catch(() => '')).slice(0, 2500),
      controls: controls.slice(0, 60),
    }
  },
})

/**
 * How long a control gets to become usable before it counts as stuck.
 *
 * Long enough for a megabyte or two of creative to be accepted and validated, short
 * enough that a genuinely dead form does not eat the run's budget.
 */
const SETTLE_TIMEOUT_MS = 15_000

/**
 * What is stopping this form from being submitted, in the tool's own terms.
 *
 * The portrait deploy died here. The creative uploaded, the fields were filled, and
 * Publish stayed greyed out — and the agent could see `DISABLED` on the button with no
 * way to tell whether that was a validation state it could clear or an upload still in
 * flight. So it stopped: correct, but blind, and the two remaining canvases were never
 * attempted.
 *
 * Naming the empty required field is the difference between "the button is disabled"
 * and something the model can act on.
 */
async function submitBlockers(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const found: string[] = []
    for (const el of [...document.querySelectorAll('input, select, textarea')]) {
      const field = el as HTMLInputElement
      if (field.type === 'hidden' || field.disabled) continue
      const label = field.name || field.id || field.type
      if (field.type === 'file') {
        if (field.required && !field.files?.length) found.push(`${label} has no file selected`)
      } else if (field.required && !field.value) {
        found.push(`${label} is required and empty`)
      }
      if (field.validationMessage) found.push(`${label}: ${field.validationMessage}`)
    }
    for (const el of [...document.querySelectorAll('button, input[type=submit]')]) {
      const button = el as HTMLButtonElement
      if (button.disabled) {
        found.push(`button "${(button.innerText || button.value || '').trim()}" is disabled`)
      }
    }
    return [...new Set(found)]
  })
}

/**
 * Poll until a control is usable, rather than clicking at one that is not.
 *
 * Playwright would block on the click until its own timeout and then throw about
 * actionability, which is a sentence about Playwright rather than about the form.
 */
async function waitEnabled(p: Page, control: Locator): Promise<{ ok: boolean; blocking: string[] }> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await control.isEnabled({ timeout: 1000 }).catch(() => false)) return { ok: true, blocking: [] }
    await p.waitForTimeout(500)
  }
  return { ok: false, blocking: await submitBlockers(p).catch(() => []) }
}

const actTool = tool({
  name: 'act',
  description:
    'Do one thing on the page: navigate, click, fill a field, or select an option. ' +
    'Returns the page afterwards so you can see what happened.',
  parameters: z.object({
    action: z.enum(['goto', 'click', 'fill', 'select', 'upload', 'press']),
    /** A CSS selector, or visible text for a click. */
    target: z.string(),
    value: z.string().nullable().describe('the text to type, option to select, or url'),
  }),
  async execute({ action, target, value }) {
    const p = currentPage()
    try {
      if (action === 'goto') {
        const url = new URL(value ?? target, hydration.target.entry_url)
        // One host. A deploy box that can be steered to another site is a much larger
        // problem than a failed deploy.
        if (url.host !== new URL(hydration.target.entry_url).host) {
          return { error: `refusing to leave ${new URL(hydration.target.entry_url).host}` }
        }
        await p.goto(url.toString(), { waitUntil: 'domcontentloaded' })
      } else if (action === 'click') {
        const byText = p.getByRole('button', { name: target, exact: false })
        const byLink = p.getByRole('link', { name: target, exact: false })
        const control = (await byText.count())
          ? byText.first()
          : (await byLink.count())
            ? byLink.first()
            : p.locator(target).first()

        /**
         * A control that is not usable *yet* is waited on and then explained, rather
         * than clicked at until Playwright gives up.
         *
         * Only when it exists. A selector matching nothing is a typo the model should
         * hear about immediately, and waiting fifteen seconds to call it "disabled"
         * would bury the one fact that could fix it — so a missing element falls
         * through to the click, whose own error names it.
         */
        const ready =
          (await control.count().catch(() => 0)) > 0
            ? await waitEnabled(p, control)
            : { ok: true, blocking: [] as string[] }
        if (!ready.ok) {
          note(`"${target}" still disabled after ${SETTLE_TIMEOUT_MS / 1000}s`)
          return {
            error: `"${target}" is still disabled after ${SETTLE_TIMEOUT_MS / 1000}s`,
            blocking: ready.blocking,
            url: p.url(),
          }
        }
        await control.click()
        await p.waitForLoadState('domcontentloaded').catch(() => {})
      } else if (action === 'fill') {
        await p.locator(target).first().fill(value ?? '')
      } else if (action === 'select') {
        await p.locator(target).first().selectOption({ label: value ?? '' }).catch(async () => {
          await p.locator(target).first().selectOption(value ?? '')
        })
      } else if (action === 'upload') {
        /**
         * The named canvas, or nothing.
         *
         * This used to fall back to `artifacts[0]` whenever the name did not match,
         * which silently publishes the wrong creative — a live ad at the wrong aspect
         * ratio, indistinguishable from success in every log we keep. An error the
         * model can correct is strictly better than a plausible wrong file.
         */
        const artifact = artifacts.find((a) => a.canvas === (value ?? ''))
        if (!artifact) {
          return {
            error:
              `no creative named ${JSON.stringify(value ?? '')}. ` +
              `Available: ${artifacts.map((a) => a.canvas).join(', ')}. ` +
              'Use one of those names exactly — never substitute another size.',
          }
        }
        await p.locator(target).first().setInputFiles(artifact.path)
        note(`uploaded ${artifact.canvas} (${artifact.bytes}B)`)
        // The tool validates on its own clock. The click that follows waits for the
        // control it needs, so this only has to cover the first repaint.
        await p.waitForTimeout(1500)
      } else if (action === 'press') {
        await p.locator(target).first().press(value ?? 'Enter')
      }
      await p.waitForTimeout(400)
      note(`${action} ${target}${value ? ` = ${value.slice(0, 40)}` : ''}`)
      return {
        ok: true,
        url: p.url(),
        text: (await p.locator('body').innerText().catch(() => '')).slice(0, 1200),
      }
    } catch (error) {
      // Returned, not thrown: a wrong selector should let the model look again rather
      // than end the run half way through a form.
      return { error: (error as Error).message.slice(0, 240) }
    }
  },
})

const signInTool = tool({
  name: 'sign_in',
  description:
    'Fill the sign-in form using the credentials from the environment. The values are ' +
    'never returned to you and never appear in the log.',
  parameters: z.object({
    email_selector: z.string(),
    password_selector: z.string(),
    submit_selector: z.string(),
  }),
  async execute({ email_selector, password_selector, submit_selector }) {
    const [userVar, passVar] = hydration.target.credential_env
    const user = process.env[userVar]
    const pass = process.env[passVar]
    if (!user || !pass) return { error: `credentials missing: ${userVar}, ${passVar}` }
    const p = currentPage()
    try {
      await p.locator(email_selector).first().fill(user)
      await p.locator(password_selector).first().fill(pass)
      await p.locator(submit_selector).first().click()
      await p.waitForLoadState('domcontentloaded')
      await p.waitForTimeout(600)
      note(`signed in as ${userVar}`)
      return { ok: true, url: p.url(), text: (await p.locator('body').innerText()).slice(0, 800) }
    } catch (error) {
      return { error: (error as Error).message.slice(0, 200) }
    }
  },
})

const findingTool = tool({
  name: 'report_finding',
  description: 'Record something a person should know, including a reason you stopped.',
  parameters: z.object({
    code: z.string(),
    severity: z.enum(['blocker', 'review', 'info']),
    detail: z.string(),
  }),
  async execute({ code, severity, detail }) {
    findings.push({ code, severity, detail })
    note(`finding ${code}: ${detail.slice(0, 90)}`)
    return { recorded: true }
  },
})

/**
 * Go back to the list and find the ad. Required before claiming `published`.
 *
 * The confirmation page is the tool telling you it worked. The list is the tool
 * showing you it worked, and those are not the same claim — the publish handler can
 * save an ad and silently drop its image when storage is full, which looks identical
 * on the confirmation screen and wrong in the list.
 *
 * It also fixes an ordering mistake: the recording used to end on the confirmation
 * page, so the video stopped one screen before the only screen that proves anything.
 * Whatever this finds, the row is on camera.
 */
const confirmTool = tool({
  name: 'confirm_in_list',
  description:
    'Return to the ad list and confirm your ad is really there. Call this after publishing ' +
    'and BEFORE record_outcome — an outcome of `published` is only accepted once this has ' +
    'found the ad. Give it a moment first: the confirmation toast clears after a few seconds ' +
    'and the list needs to be reloaded, not remembered.',
  parameters: z.object({
    ad_name: z.string().describe('the exact ad name to look for in the list'),
    list_url: z.string().describe('the url of the list page, e.g. the Ads Manager link'),
  }),
  async execute({ ad_name, list_url }) {
    // Long enough for the toast to clear and any write to settle, so the list is read
    // rather than a stale render of it.
    const active = currentPage()

    // The same one-host rule `act` enforces. This navigates to a model-supplied url and
    // had no guard at all, which made it the way around the rule rather than an
    // exception to it.
    const entry = new URL(hydration.target.entry_url)
    const destination = new URL(list_url, hydration.target.entry_url)
    if (destination.host !== entry.host) {
      return { found: false, error: `refusing to leave ${entry.host}` }
    }

    /**
     * Long enough to outlive the success toast.
     *
     * The tool's toast lasts six seconds and does **not** clear on navigation, so it
     * follows you onto the list carrying the ad's name in its own text. Reading
     * `body.innerText` at five seconds therefore found the ad in the toast rather than
     * in the list — the confirmation screen wearing the list's clothes, which is the
     * exact claim this tool exists to refuse. Publishing itself takes two to nine
     * seconds, so the wait is measured generously from here.
     */
    await active.waitForTimeout(9000)
    await active.goto(destination.toString(), { waitUntil: 'domcontentloaded' })
    await active.waitForTimeout(1500)

    /**
     * The list's own text, with any transient banner removed.
     *
     * Belt and braces against the same toast: waiting it out is the primary defence,
     * and stripping anything that announces itself as a notification means a slower
     * tool than advertised still cannot fake a confirmation.
     */
    const text = await active.evaluate(() => {
      const TRANSIENT = '[role=status], [role=alert], [class*=toast], [class*=notification], [class*=flash], [class*=banner]'
      const clone = document.body.cloneNode(true) as HTMLElement
      for (const el of [...clone.querySelectorAll(TRANSIENT)]) el.remove()
      return clone.innerText
    })
    const found = text.includes(ad_name)
    // On camera either way, and paused so the frame is legible in the recording.
    await active.waitForTimeout(2500)

    if (found) listConfirmed.add(ad_name)
    note(`list check for "${ad_name}" at ${list_url}: ${found ? 'FOUND' : 'NOT FOUND'}`)
    if (!found) {
      findings.push({
        code: 'ad-absent-from-list',
        severity: 'blocker',
        detail:
          `the tool reported publishing "${ad_name}" but it is not in the list at ${list_url} — ` +
          'the confirmation page cannot be taken as evidence on its own',
      })
    }
    return {
      found,
      // The row as the tool renders it, so the result file carries what was seen.
      list_excerpt: text.slice(0, 1200),
    }
  },
})

/**
 * Ad names confirmed present in the tool's own list.
 *
 * A set rather than a flag, because one deploy publishes one ad per canvas. Counting
 * them is what makes a partial deploy visible: two of three confirmed is a different
 * fact from three of three, and the earlier single-value version could not tell them
 * apart.
 */
const listConfirmed = new Set<string>()

const verifyTool = tool({
  name: 'record_outcome',
  description:
    'Report the outcome. Call this exactly once, at the end. `published` requires BOTH a url ' +
    'you actually read off the page after publishing — not one you expected — and a successful ' +
    'confirm_in_list call.',
  parameters: z.object({
    outcome: z.enum(['published', 'unverified', 'stopped']),
    verified_url: z.string().nullable(),
    note: z.string(),
  }),
  async execute({ outcome, verified_url, note: detail }) {
    /**
     * `published` is downgraded when the list never confirmed it.
     *
     * Enforced here rather than trusted to the prompt, because this is the one claim
     * the whole deploy is judged on and a model that skipped a step should not be
     * able to assert it anyway.
     */
    let effective = outcome
    const expected = hydration.publish.length
    if (outcome === 'published' && listConfirmed.size < expected) {
      /**
       * Partial is not published.
       *
       * Every canvas in `publish` is an ad someone is expecting to be live. Reporting
       * `published` with two of three in the tool would leave the third missing and
       * nothing saying so — and a missing ad is exactly the kind of gap that is only
       * noticed by whoever checks the campaign a week later.
       */
      effective = 'unverified'
      note(
        `published downgraded to unverified — ${listConfirmed.size}/${expected} ad(s) confirmed in the list`,
      )
      findings.push({
        code: listConfirmed.size === 0 ? 'publish-unconfirmed' : 'publish-partial',
        severity: 'blocker',
        detail:
          `${listConfirmed.size} of ${expected} ad(s) were confirmed in the tool's list` +
          (listConfirmed.size ? ` (${[...listConfirmed].join(', ')})` : '') +
          '; recorded as unverified rather than published',
      })
    }
    outcome = effective
    note(`outcome ${outcome}${verified_url ? ` at ${verified_url}` : ''}`)

    /**
     * Kept, so the report can say what was decided.
     *
     * This variable was declared and read and never once assigned, so every RESULT.json
     * ever written fell through to "the agent never reported an outcome" — including the
     * runs where it had reported one, and including the downgrades decided just above.
     * The effective outcome is stored rather than the claimed one: the report should
     * agree with the record, not with the model.
     */
    outcomeReported = { outcome, verified_url: verified_url ?? null, note: detail }

    /**
     * Written to the deployment row, not only to the result file.
     *
     * The launcher decides `published` versus `unverified` by looking for a recording
     * AND a url in this column. If the agent only wrote a local variable, every deploy
     * would come back unverified no matter what actually happened — which is the
     * mistake the generation agent made with its findings.
     */
    await writeOutcome(outcome, verified_url ?? null, detail)

    /**
     * The recording ends where the truth is.
     *
     * The last navigation used to be `confirm_in_list`, so every video finished on the
     * list — one screen past the ad's own detail page, which is the page the brief
     * calls the only place the truth lives. Going back is the final act rather than an
     * instruction, because a step that only matters to the person watching afterwards
     * is exactly the step a model drops when it is running low on turns.
     */
    if (verified_url) {
      const p = currentPage()
      try {
        const entry = new URL(hydration.target.entry_url)
        const detailUrl = new URL(verified_url, hydration.target.entry_url)
        if (detailUrl.host === entry.host) {
          await p.goto(detailUrl.toString(), { waitUntil: 'domcontentloaded' })
          // Held on camera long enough to read in playback.
          await p.waitForTimeout(4000)
          note(`recording ends on ${detailUrl.pathname}`)
        }
      } catch (error) {
        note(`could not return to the detail page: ${(error as Error).message.slice(0, 90)}`)
      }
    }
    return { recorded: true }
  },
})

let outcomeReported: { outcome: string; verified_url: string | null; note: string } | null = null

/**
 * Writes the outcome to the deployment row.
 *
 * Extracted from `record_outcome` so the run can also file one when the agent never
 * gets there. A run that exhausts its turns mid-third-ad has still published two, and
 * leaving the row untouched threw both away: the launcher saw a row that had never been
 * written to and recorded `unverified` with no note, so the record said nothing at all
 * about two ads that are live in someone's account right now.
 */
async function writeOutcome(outcome: string, verifiedUrl: string | null, detail: string) {
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  const token = process.env.CQ_RUN_TOKEN
  if (!url || !anon || !token) return
  try {
    const response = await fetch(`${url}/rest/v1/deployments?id=eq.${await deploymentId()}`, {
      method: 'PATCH',
      headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verified_url: verifiedUrl,
        verified_note: detail.slice(0, 500),
        status: outcome === 'published' ? 'published' : outcome === 'stopped' ? 'stopped' : 'unverified',
      }),
    })
    if (!response.ok) console.error(`[deploy] outcome not recorded: ${response.status}`)
  } catch (error) {
    console.error(`[deploy] outcome not recorded: ${(error as Error).message}`)
  }
}

/**
 * Which deployment this box is for.
 *
 * Asked of the database rather than passed in the hydration file: the policy already
 * resolves it from the run id, so reading it here means the box and the policy can
 * never disagree about which deployment it is allowed to touch.
 */
let cachedDeploymentId: string | null = null
async function deploymentId(): Promise<string> {
  if (cachedDeploymentId) return cachedDeploymentId
  const url = process.env.SUPABASE_URL
  const anon = process.env.SUPABASE_ANON_KEY
  const token = process.env.CQ_RUN_TOKEN
  const response = await fetch(`${url}/rest/v1/deployments?select=id&limit=1`, {
    headers: { apikey: anon as string, Authorization: `Bearer ${token}` },
  })
  const rows = (await response.json()) as { id: string }[]
  cachedDeploymentId = rows[0]?.id ?? ''
  return cachedDeploymentId
}

const agent = new Agent({
  name: 'deploy-campaign',
  model: MODEL,
  instructions: [
    'You are publishing finished, approved advertising into a marketing tool by driving',
    'its interface. The tool is not ours. Read each page before acting, and never assume',
    'a control is where it was last time.',
    '',
    'The contract you must follow is below, in full.',
    '',
    `--- BEGIN SKILL: ${hydration.skill.invoke} ---`,
    skillBody,
    '--- END SKILL ---',
    '',
    `Entry url: ${hydration.target.entry_url}`,
    `Our campaign name: ${hydration.campaign.name}`,
    hydration.target.campaign
      ? `In ${hydration.target.tool}, attach the ad to the existing campaign "${hydration.target.campaign}".`
      : `No campaign in ${hydration.target.tool} was chosen. If the tool requires one, stop and report it.`,
    hydration.target.objective
      ? `Objective to select: "${hydration.target.objective}".`
      : '',
    Object.keys(hydration.target.fields ?? {}).length
      ? 'Values supplied for the tool\'s own fields — use these and do not invent others:\n' +
        Object.entries(hydration.target.fields)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n')
      : 'No extra tool fields were supplied. If the form requires any, stop and report it.',
    hydration.target.notes ? `Notes from the person deploying: ${hydration.target.notes}` : '',
    /**
     * One ad per canvas, and every one named differently.
     *
     * This used to read `Name the ad "<campaign>"`, which is unusable for a multi-canvas
     * deploy in two directions at once: the person auditing the list cannot tell three
     * identical rows apart, and `listConfirmed` is a set of names, so three successful
     * publishes counted as one and a complete deploy was downgraded to unverified every
     * time. The skill already states the rule; the prompt now states the same one.
     */
    `Name each ad "${hydration.campaign.name} (<canvas>)" — the canvas name in brackets,`,
    'so the ads are told apart in the list. One ad per canvas, and never two the same.',
    '',
    /**
     * Copy is context, not a source of form values.
     *
     * The tool's body field is supplied in the fields above, composed from the approved
     * copy before the box opened. Left to assemble it here, one run stopped rather than
     * guess — correct — and another invented "testing the rendering" and published it.
     */
    `Copy for reference only — do NOT assemble form values out of it, and never type any`,
    `of it into a field. Every value the form needs is in the list above.`,
    `  ${JSON.stringify(hydration.campaign.copy)}`,
    '',
    `Creative already downloaded and ready to upload, by canvas: ${artifacts
      .map((a) => `${a.canvas} (${a.bytes}B)`)
      .join(', ')}`,
    '',
    'Use `upload` with the canvas name as the value; the file is already on disk.',
    'If a control is disabled, `act` waits for it and then tells you what is blocking',
    'the form. Read that before deciding you are stuck — an empty required field is',
    'something you can fix, and a stop costs every canvas you had not reached yet.',
    '',
    'Stop and report rather than guessing if: sign-in fails, a required field has no',
    'value you were given, an upload is rejected, or the page is not what the url',
    'implied. A half-created campaign is worse than none, because someone has to find it',
    'before they can undo it.',
    '',
    /**
     * A blocker is scoped to the ad it happened on.
     *
     * "Stop and report" was being read as "abandon the run", so one awkward form left
     * the remaining canvases unattempted and unmentioned. Nothing about a rejected
     * portrait makes publishing square unsafe — they are separate ads — and the sizes
     * that never went live are the ones nobody finds out about.
     */
    'A blocker stops THAT AD, not the run. Report it with report_finding, then start the',
    'next canvas from the beginning of the flow. Only sign-in failure and a tool that is',
    'not what the url implied end everything, because those affect every ad equally.',
    '',
    'Call record_outcome once at the very end, after the last canvas, whatever happened',
    'to the ones before it. An unreported run is recorded as if nothing shipped.',
    '',
    'When you have published, read the resulting page and call record_outcome with the',
    'url you actually see. If you could not confirm it, say `unverified` — never',
    '`published` on an expectation.',
  ].join('\n'),
  tools: [readTool, actTool, signInTool, findingTool, confirmTool, verifyTool],
})

note(`agent ${MODEL} · ${artifacts.length} artifact(s) · ${hydration.target.entry_url}`)

/**
 * The turn budget, scaled to the work.
 *
 * This was a flat 60, chosen when a deploy meant one ad. One ad through Adstream's
 * three-step flow costs about twenty-five turns — campaign, objective, next, audience,
 * placements, budget, next, upload, name, body, call to action, publish, confirm, and a
 * `read_page` between most of them, because the interface is not ours and a remembered
 * layout is not a reliable one.
 *
 * Three ads therefore never fit. The run that found this published landscape, published
 * portrait, and died partway through square on `Max turns (60) exceeded` — two ads live
 * in a customer's account and a record that mentioned neither.
 *
 * Forty per canvas leaves real headroom for a form that argues back, plus a fixed
 * allowance for sign-in and for reporting at the end. The wall-clock budget is the
 * outer limit; this one exists so the loop cannot spin, not to ration honest work.
 */
const MAX_TURNS = 25 + 40 * artifacts.length

try {
  const result = await run(
    agent,
    `Publish "${hydration.campaign.name}" to ${hydration.target.tool}. Start at ${hydration.target.entry_url}.\n` +
      `There are ${artifacts.length} ad(s) to create — one per canvas — and you have ` +
      `${MAX_TURNS} turns for all of them. Do not re-read a page you have just acted on.`,
    { maxTurns: MAX_TURNS },
  )
  console.log(`\nagent finished:\n${result.finalOutput}`)
} catch (error) {
  findings.push({ code: 'deploy-aborted', severity: 'blocker', detail: (error as Error).message })
  console.error(`deploy failed: ${(error as Error).message}`)
} finally {
  /**
   * An aborted run still files what it achieved.
   *
   * `record_outcome` is the agent's last step, so anything that kills the loop before
   * it — exhausted turns, a thrown tool, the wall clock — used to leave the deployment
   * row exactly as the launcher had set it, and the two ads that were confirmed in the
   * tool's own list went unmentioned anywhere a person would look.
   */
  if (!outcomeReported) {
    const confirmed = [...listConfirmed]
    await writeOutcome(
      'unverified',
      null,
      `the run ended before reporting an outcome; ${confirmed.length} of ${hydration.publish.length} ` +
        `ad(s) were confirmed in the tool's list` +
        (confirmed.length ? ` (${confirmed.join(', ')})` : '') +
        '. These are live and were not recorded by the agent itself.',
    ).catch(() => {})
    findings.push({
      code: 'outcome-unreported',
      severity: 'blocker',
      detail:
        `the agent never called record_outcome; ${confirmed.length} of ${hydration.publish.length} ad(s) ` +
        'were confirmed in the list before the run ended',
    })
  }

  // A moment before the context closes, so the last frames are encoded rather than
  // lost. Video is written on close and the encoder is not instantaneous.
  await page?.waitForTimeout(2000).catch(() => {})
  // Close the context first, always. The video is written on close, and a box killed
  // with it still in memory produces a deploy nobody can evidence.
  try {
    await context?.close()
    note('recording flushed on context close')
  } catch (error) {
    console.error(`could not close the recording context: ${(error as Error).message}`)
  }
  await browser.close().catch(() => {})

  /**
   * The longest recording, not the first one on disk.
   *
   * Playwright writes one video per page, so a tool that opens a tab leaves two files
   * and `readdirSync` returns them in whatever order the filesystem likes. Reporting
   * `videos[0]` could therefore name a three-second recording of a popup as the
   * evidence for the run. Every file is still uploaded by `save_work`; this only picks
   * which one the report points at, and size is the closest proxy for "the session".
   */
  const videos = existsSync(RECORDING_DIR)
    ? readdirSync(RECORDING_DIR)
        .filter((f) => f.endsWith('.webm'))
        .sort((a, b) => statSync(join(RECORDING_DIR, b)).size - statSync(join(RECORDING_DIR, a)).size)
    : []
  if (videos.length === 0) {
    findings.push({
      code: 'recording-missing',
      severity: 'blocker',
      detail: 'no recording was written, so this deploy cannot be evidenced',
    })
  }

  /**
   * One report per run, named by the run.
   *
   * A single `deploy/RESULT.json` per revision could not work: saving is append-only,
   * so a second deploy of the same revision skipped the file entirely and the record
   * kept a *stopped* run's report while the deployment row said published. Four
   * attempts is a normal number for a form nobody has driven before, and every one of
   * them deserves its own account.
   */
  writeFileSync(
    join(RECORDING_DIR, `RESULT-${hydration.run_id}.json`),
    JSON.stringify(
      {
        deployment: hydration.campaign.name,
        revision_id: hydration.revision_id,
        target: hydration.target.tool,
        /**
         * What was confirmed in the tool's own list, and separately what was tried.
         *
         * `published` used to be the *download* list, so a run that stopped after one
         * canvas filed a report stating all three had shipped. The two facts are now
         * two keys, because "we fetched three files" and "three ads exist" are
         * different claims and only one of them is about the tool.
         */
        published: artifacts
          .filter((a) => [...listConfirmed].some((name) => name.includes(a.canvas)))
          .map((a) => ({ canvas: a.canvas, bytes: a.bytes, digest: a.digest })),
        attempted: artifacts.map((a) => ({
          canvas: a.canvas,
          bytes: a.bytes,
          digest: a.digest,
        })),
        confirmed_in_list: [...listConfirmed],
        outcome: outcomeReported ?? {
          outcome: 'unverified',
          verified_url: null,
          note: 'the agent never reported an outcome',
        },
        steps,
        findings,
        recording: videos[0] ?? null,
      },
      null,
      2,
    ) + '\n',
  )

  // Last segment out before the final save. Stops the timer too, so nothing races the
  // `--final` call that marks the revision.
  transcript.stop()

  try {
    execFileSync('save_work', ['--final'], { encoding: 'utf8', timeout: 180_000, stdio: 'inherit' })
  } catch {
    console.error('save_work failed on the deploy box')
  }
}
