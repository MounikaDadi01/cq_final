/**
 * Hydration: what a box is given, in what order, and what it is deliberately not.
 *
 * The whole system is one idea — everything is a file system, and files and skills
 * are hydrated in different orders at different times. A hydration file is the
 * manifest of that: what lands in the box, where it came from, what the agent is
 * being asked to do, and what it already knows so it does not spend a run
 * rediscovering it.
 *
 * Five properties are load-bearing:
 *
 *   1. **Nothing here names a customer.** Every brand-specific value arrives as
 *      data resolved from the request's kit id. A third brand must run with no code
 *      change, so a hydration file mentioning a brand would be a bug even if it
 *      happened to work.
 *
 *   2. **The skill is mounted, not inlined.** `SKILL.md` goes into the box as a
 *      skill the agent invokes — the same bytes a developer invokes locally.
 *      Paraphrasing it into a prompt would create a second source of truth.
 *
 *   3. **Ordering is declared, never assumed.** "Whatever order the code happens
 *      to read things in" is precisely the hardcoded ordering the brief
 *      disqualifies.
 *
 *   4. **Context travels with the job.** Prior conversation, resolved brand values,
 *      known findings, and — on an edit — the parent's tree. An agent that has to
 *      re-derive a font substitution or re-read a chat thread wastes the run and
 *      may reach a different answer than last time, which reads to a customer as
 *      the system changing its mind.
 *
 *   5. **What is withheld is stated.** The negative space is the interesting part
 *      of an isolation claim, so it is written down rather than left implicit in
 *      whatever the loader happened to skip.
 */

/** Where a file lands inside the box, and why it is there. */
export interface MountedFile {
  /** Absolute path inside the sandbox. */
  path: string
  /**
   * Where the bytes come from.
   *
   * `baked` — in the template image already, identical for every run.
   * `kit`    — pulled fresh per customer from the `brains` bucket.
   * `job`    — written for this run only.
   */
  lifetime: 'baked' | 'kit' | 'job'
  /** Storage key when the box fetches it, null when the template carries it. */
  storageKey: string | null
  /** Plain-English reason this file is present. Read by humans reviewing a run. */
  purpose: string
  /** sha256 of the bytes, so hydration fidelity is checkable digest for digest. */
  digest?: string
  /** Size, so a box can report a truncated fetch rather than working on a stub. */
  bytes?: number
}

/** A file that could have been mounted and was not, with the reason. */
export interface WithheldFile {
  path: string
  reason: string
}

export interface CanvasSpec {
  name: string
  width: number
  height: number
  /** False when no legal generation size exists; the reason travels with it. */
  producible: boolean
  refusal?: string
}

/** What the brand resolution already settled, so the box need not redo it. */
export interface ResolvedBrand {
  palette: Record<string, string>
  type_scale: Record<string, string>
  heading_family: string | null
  body_family: string | null
  heading_substituted: boolean
  heading_note: string | null
  /**
   * Fields where the kit's own documents disagreed, and what won.
   *
   * Carried so the agent does not re-litigate a contested value and reach a
   * different answer than the last run did on the same input.
   */
  contested: string[]
  /**
   * The luminance at which this kit's reverse logo takes over, when the kit
   * states one. A brand's own threshold outranks any constant of ours.
   */
  ground_switch_point: { value: number; source: string } | null
}

export interface KnownFinding {
  code: string
  severity: 'blocker' | 'review' | 'info'
  detail: string
}

export interface ConversationTurn {
  role: 'user' | 'agent' | 'system'
  body: string
  at: string
}

/** What a parent revision produced, for an edit to build on. */
export interface ParentRevision {
  revision_id: string
  n: number
  /** Every artifact, so the agent can see what exists before changing anything. */
  tree: {
    relative_path: string
    role: string
    canvas: string | null
    /** Time-limited read URL, sharing the run budget. */
    signed_url: string
  }[]
  /** Findings the parent recorded, so a known limitation is not rediscovered. */
  findings: KnownFinding[]
}

export interface GenerationHydration {
  kind: 'generate'
  /** Schema version, so a box can refuse a shape it does not understand. */
  version: 1
  run_id: string
  revision_id: string
  /**
   * Present because RLS policies read it, and absent from the sandbox *identity*.
   * A box is named by its provider handle alone — a name spelling out a tenant
   * would be a box identity naming a customer.
   */
  brand_kit_id: string

  /** `new` generates from scratch; `edit` revises a parent revision. */
  task: 'new' | 'edit'
  parent_revision_id: string | null
  /** Non-null only for an edit: what the human asked to change, in their words. */
  edit_instruction: string | null

  campaign: {
    name: string
    copy: Record<string, string | null>
    plate_direction: string | null
    /** Exact filenames. Empty means none attached, which is a legal state. */
    inspirations: string[]
  }
  canvases: CanvasSpec[]

  /**
   * The skill the agent must follow, mounted as a skill rather than a prompt.
   *
   * `invoke` is the name the agent calls. The body is the packet's own `SKILL.md`,
   * unmodified, so the contract in the box is the contract in the repo.
   */
  skill: {
    invoke: string
    mount: MountedFile
  }

  /** Read in this order. Stated, not inferred from code. */
  resolution_order: string[]

  mounts: MountedFile[]

  /** Everything already known, so the run starts where the last one left off. */
  context: {
    conversation: ConversationTurn[]
    resolved: ResolvedBrand
    known_findings: KnownFinding[]
    parent: ParentRevision | null
  }

  /** Files that exist and are deliberately not mounted. */
  withheld: WithheldFile[]

  /** What the agent must produce, and where it must put it. */
  outputs: {
    /** Relative to the revision prefix. The tree in is the tree out. */
    root: string
    /** The agent calls this to save its own work. Nothing else moves it. */
    save_with: string
    /** Save partial progress at least this often, in seconds. */
    checkpoint_every_seconds: number
    /**
     * The shape the agent is expected to produce, per canvas.
     *
     * Stated so a half-finished run is recognisable as half-finished rather than
     * looking like a complete run that produced less.
     */
    expected_tree: string[]
  }

  /** Everything the box may reach, named so an unexpected egress is visible. */
  egress: string[]

  limits: {
    /** Wall-clock budget. Signed URLs and the run token share it. */
    sandbox_timeout_seconds: number
    image_quality: 'low' | 'medium' | 'high'
    /** Cap on image calls, so a loop cannot spend without bound. */
    max_image_calls: number
  }
}

export interface DeploymentHydration {
  kind: 'deploy'
  version: 1
  run_id: string
  revision_id: string
  brand_kit_id: string

  /**
   * Exactly what to publish.
   *
   * Resolved by the backend from the revision's artifacts and handed over as a
   * list, rather than left for the box to discover. A deploy box that had to work
   * out what counts as finished could publish a half-saved revision — and a
   * partial deploy is the failure with the least recoverable consequences here.
   */
  publish: {
    canvas: string
    /** Relative path within the revision tree. */
    relative_path: string
    /** Time-limited URL, minted with the same budget as the sandbox timeout. */
    signed_url: string
    /**
     * What the artifact should weigh.
     *
     * The skill has always required the box to check each download against the
     * manifest, and until this existed there was no number to check it against — so
     * the one stated invariant that could catch a truncated fetch was unimplementable.
     */
    bytes: number
    width: number
    height: number
  }[]

  /** The copy that belongs with the creative, so fields can be filled in. */
  campaign: {
    name: string
    copy: Record<string, string | null>
  }

  /** Where it goes. A tool name and a starting URL, never credentials in the file. */
  target: {
    tool: string
    entry_url: string
    /**
     * The tool's own campaign and objective, chosen by a person.
     *
     * Present because a real marketing tool has its own taxonomy and will not accept
     * our campaign name as free text. Null means the agent stops rather than guessing —
     * an invented campaign attaches an ad to the wrong budget.
     */
    campaign?: string | null
    objective?: string | null
    notes?: string | null
    /** Whatever else the tool's form asks for, supplied by a person. */
    fields?: Record<string, string>
    /**
     * How the box authenticates.
     *
     * `env` names the variable holding the secret. The secret itself is set on the
     * sandbox environment, not written into the hydration file, because the file
     * is saved alongside the run for audit and a credential in it would be
     * readable for as long as the record exists.
     */
    credential_env: string[]
  }

  skill: {
    invoke: string
    mount: MountedFile
  }

  resolution_order: string[]
  mounts: MountedFile[]

  context: {
    conversation: ConversationTurn[]
    known_findings: KnownFinding[]
  }

  withheld: WithheldFile[]

  outputs: {
    /**
     * A deploy writes only under here, and only a recording.
     *
     * Reserved subdirectory of the same revision prefix: same tree, so nothing
     * has to reconcile two key spaces, and a recording can never overwrite a
     * render.
     */
    root: string
    save_with: string
    /**
     * Non-negotiable. Playwright flushes video on context close, so a killed box
     * loses it — and no recording means no evidence a deploy happened. The
     * recording is uploaded before the run reports completion, never after.
     */
    recording_required: true
    expected_tree: string[]
  }

  egress: string[]

  limits: {
    sandbox_timeout_seconds: number
  }
}

export type Hydration = GenerationHydration | DeploymentHydration

/** The shared budget: token lifetime, signed URLs and sandbox timeout all agree. */
export const RUN_BUDGET_SECONDS = 20 * 60

const SANDBOX_ROOT = '/home/user'
const SKILL_PATH = `${SANDBOX_ROOT}/.claude/skills/design-generation/SKILL.md`
const DEPLOY_SKILL_PATH = `${SANDBOX_ROOT}/.claude/skills/deploy-campaign/SKILL.md`

/**
 * Files that exist in a brain and are never hydrated, with the reason each.
 *
 * Written as data so the list is reviewable, and so a box can be checked against
 * it. `tokens.json` is the one that matters: it is a cache, it disagrees with
 * `DESIGN.md`, and it is the *newer* file — so anything resolving by recency picks
 * the wrong value three times over. The safest way to not consult it is for it not
 * to be there.
 */
export const NEVER_HYDRATED: WithheldFile[] = [
  {
    path: 'brand/tokens.json',
    reason:
      'a cache with no authority that disagrees with DESIGN.md and is newer than it; ' +
      'withheld so nothing in the box can resolve a brand value from it',
  },
]

export interface KitFileInput {
  /** Path relative to the brain root, e.g. `DESIGN.md` or `fonts/x.ttf`. */
  path: string
  storageKey: string
  purpose: string
  digest?: string
  bytes?: number
}

export interface GenerationInput {
  runId: string
  revisionId: string
  brandKitId: string
  task: 'new' | 'edit'
  parentRevisionId?: string | null
  editInstruction?: string | null
  campaignName: string
  copy: Record<string, string | null>
  plateDirection: string | null
  /** Attached by filename. Only these are mounted. */
  inspirations: string[]
  /** Storage keys for attached inspirations, in the same order. */
  inspirationKeys?: { path: string; storageKey: string; digest?: string; bytes?: number }[]
  canvases: CanvasSpec[]
  /** Brand files: DESIGN.md, manifest, every available asset, every shipped font. */
  kitFiles: KitFileInput[]
  resolved: ResolvedBrand
  knownFindings?: KnownFinding[]
  conversation?: ConversationTurn[]
  parent?: ParentRevision | null
  withheld?: WithheldFile[]
  skillDigest?: string
  quality?: 'low' | 'medium' | 'high'
  maxImageCalls?: number
}

/**
 * Builds the generation hydration file.
 *
 * Every brand-specific value is an argument. Nothing is looked up by name here,
 * which is what makes a third brand a data problem rather than a code change.
 */
export function buildGenerationHydration(input: GenerationInput): GenerationHydration {
  const skillMount: MountedFile = {
    // Baked into the template: the contract is the same for every customer and
    // every run, so pulling it per run would add a failure mode for no benefit.
    path: SKILL_PATH,
    lifetime: 'baked',
    storageKey: null,
    purpose: 'the contract every step of the build must satisfy',
    ...(input.skillDigest ? { digest: input.skillDigest } : {}),
  }

  const kitMounts: MountedFile[] = input.kitFiles.map((f) => ({
    path: `${SANDBOX_ROOT}/brain/${f.path}`,
    lifetime: 'kit',
    storageKey: f.storageKey,
    purpose: f.purpose,
    ...(f.digest ? { digest: f.digest } : {}),
    ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
  }))

  // Only what the request attached. An inspiration merely sitting in a directory
  // is not selected, so mounting the directory would change what "attached" means.
  const inspirationMounts: MountedFile[] = (input.inspirationKeys ?? []).map((f) => ({
    path: `${SANDBOX_ROOT}/inspirations/${f.path}`,
    lifetime: 'job',
    storageKey: f.storageKey,
    purpose: 'composition reference only — never colour, type, copy, or an asset',
    ...(f.digest ? { digest: f.digest } : {}),
    ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
  }))

  const hydrationSelf: MountedFile = {
    path: `${SANDBOX_ROOT}/hydration.json`,
    lifetime: 'job',
    storageKey: null,
    purpose: 'this file — the request, the context, and the order to read things in',
  }

  const parentMounts: MountedFile[] = (input.parent?.tree ?? []).map((a) => ({
    path: `${SANDBOX_ROOT}/parent/${a.relative_path}`,
    lifetime: 'job',
    storageKey: null,
    purpose: `what revision ${input.parent?.n} produced (${a.role}) — read before changing it`,
  }))

  return {
    kind: 'generate',
    version: 1,
    run_id: input.runId,
    revision_id: input.revisionId,
    brand_kit_id: input.brandKitId,

    task: input.task,
    parent_revision_id: input.parentRevisionId ?? null,
    edit_instruction: input.editInstruction ?? null,

    campaign: {
      name: input.campaignName,
      copy: input.copy,
      plate_direction: input.plateDirection,
      inspirations: input.inspirations,
    },
    canvases: input.canvases,

    skill: { invoke: 'design-generation', mount: skillMount },

    // The order SKILL.md itself sets out. Written down so it is auditable rather
    // than emergent, and so a box can be checked against it.
    resolution_order: [
      'hydration.json — the request: what to make, at which sizes, with which copy',
      'skill design-generation — the contract every step must satisfy',
      'DESIGN.md — the brand. Wins over every other artifact, including this file',
      'brand/asset_manifest.json — staged assets, already filtered to this kit id',
      'fonts/ — the families the kit actually ships, not the ones it names',
      'context.resolved — substitutions and contested values already settled',
      'context.conversation — what the human has already asked for',
      'parent/ — on an edit, what the previous revision produced',
      'inspirations/ — composition reference only, and only those attached above',
    ],

    mounts: [hydrationSelf, skillMount, ...kitMounts, ...inspirationMounts, ...parentMounts],

    context: {
      conversation: input.conversation ?? [],
      resolved: input.resolved,
      known_findings: input.knownFindings ?? [],
      parent: input.parent ?? null,
    },

    withheld: [...NEVER_HYDRATED, ...(input.withheld ?? [])],

    outputs: {
      root: `${SANDBOX_ROOT}/work`,
      save_with: 'save_work',
      // Frequent enough that an abrupt death costs one canvas rather than the run.
      checkpoint_every_seconds: 60,
      expected_tree: input.canvases
        .filter((c) => c.producible)
        .flatMap((c) => [
          `html_${c.name}/index.html`,
          `html_${c.name}/assets/plate.png`,
          `renders/${c.name}.png`,
        ])
        .concat(['RESULT.json']),
    },

    egress: [
      'api.openai.com — image generation and the agent model',
      '<project>.supabase.co — brain reads and work writes, scoped by the run token',
    ],

    limits: {
      sandbox_timeout_seconds: RUN_BUDGET_SECONDS,
      image_quality: input.quality ?? 'high',
      // One generation per producible canvas, plus headroom for a retry each.
      max_image_calls:
        input.maxImageCalls ?? input.canvases.filter((c) => c.producible).length * 2,
    },
  }
}

export interface DeploymentInput {
  runId: string
  revisionId: string
  brandKitId: string
  publish: DeploymentHydration['publish']
  target: DeploymentHydration['target']
  campaignName: string
  copy: Record<string, string | null>
  conversation?: ConversationTurn[]
  knownFindings?: KnownFinding[]
  withheld?: WithheldFile[]
  skillDigest?: string
}

/** Builds the deployment hydration file: what to publish, where, and how to prove it. */
export function buildDeploymentHydration(input: DeploymentInput): DeploymentHydration {
  const skillMount: MountedFile = {
    path: DEPLOY_SKILL_PATH,
    lifetime: 'baked',
    storageKey: null,
    purpose: 'how to drive the tool, and what counts as done',
    ...(input.skillDigest ? { digest: input.skillDigest } : {}),
  }

  const hydrationSelf: MountedFile = {
    path: `${SANDBOX_ROOT}/hydration.json`,
    lifetime: 'job',
    storageKey: null,
    purpose: 'this file — which artifacts to publish, and where',
  }

  return {
    kind: 'deploy',
    version: 1,
    run_id: input.runId,
    revision_id: input.revisionId,
    brand_kit_id: input.brandKitId,

    publish: input.publish,
    campaign: { name: input.campaignName, copy: input.copy },
    target: input.target,

    skill: { invoke: 'deploy-campaign', mount: skillMount },

    resolution_order: [
      'hydration.json — which artifacts to publish, and where',
      'skill deploy-campaign — how to drive the tool, and what counts as done',
      'the signed URLs above — the only bytes to upload; nothing is regenerated here',
      'context.conversation — what the human asked for, for any field that needs it',
    ],

    mounts: [hydrationSelf, skillMount],

    context: {
      conversation: input.conversation ?? [],
      known_findings: input.knownFindings ?? [],
    },

    withheld: [
      {
        path: 'brain/**',
        reason:
          'a deploy publishes finished artifacts and has no reason to open a logo or a font; ' +
          'the deploy role is granted nothing on brand_assets or brand_fonts',
      },
      ...(input.withheld ?? []),
    ],

    outputs: {
      root: `${SANDBOX_ROOT}/work/deploy`,
      save_with: 'save_work',
      recording_required: true,
      expected_tree: ['deploy/session.webm', 'deploy/RESULT.json'],
    },

    egress: [
      `${new URL(input.target.entry_url).host} — the marketing tool being driven`,
      '<project>.supabase.co — artifact reads and the recording write',
    ],

    limits: { sandbox_timeout_seconds: RUN_BUDGET_SECONDS },
  }
}

/**
 * Scans a built hydration file for values that should never appear in one.
 *
 * A negative check, deliberately: the interesting question is not "did we include
 * the campaign name" but "did a credential or a hardcoded brand leak in". Run
 * before a box is created, so a leak refuses to launch rather than being found in
 * a log afterwards.
 */
export function hydrationLeaks(
  hydration: Hydration,
  forbidden: { secrets: string[]; brandNames: string[] },
): string[] {
  const serialised = JSON.stringify(hydration)
  const leaks: string[] = []

  for (const secret of forbidden.secrets) {
    // Short values would match by coincidence and turn this into noise.
    if (secret.length >= 12 && serialised.includes(secret)) {
      leaks.push(`a secret value appears in the hydration file (${secret.slice(0, 6)}…)`)
    }
  }

  for (const name of forbidden.brandNames) {
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    // The kit id legitimately identifies the tenant, and brand *content* is the
    // job. Only the structural half is checked: paths, ordering, output shape and
    // the skill. A brand name there would mean the pipeline knows a customer.
    const structural = JSON.stringify({
      resolution_order: hydration.resolution_order,
      outputs: hydration.outputs,
      skill: hydration.skill,
      mount_paths: hydration.mounts.map((m) => m.path),
    })
    if (pattern.test(structural)) {
      leaks.push(`brand name "${name}" appears in the structure of the hydration file`)
    }
  }

  return leaks
}

/**
 * Checks that a hydration file mounts everything a run needs.
 *
 * Separate from building it, because the two failures are different: a builder bug
 * produces a malformed file, while a *resolution* bug produces a well-formed file
 * that is quietly missing the fonts. The second one still generates an ad — one
 * set in a browser fallback face, which looks fine and is the wrong brand.
 */
export function hydrationGaps(hydration: GenerationHydration): string[] {
  const gaps: string[] = []
  const paths = hydration.mounts.map((m) => m.path)
  const has = (fragment: string) => paths.some((p) => p.includes(fragment))

  if (!has('/brain/DESIGN.md')) gaps.push('DESIGN.md is not mounted — the brand is absent')
  if (!has('asset_manifest.json')) gaps.push('the asset manifest is not mounted')
  if (!paths.some((p) => p.includes('/brain/fonts/'))) {
    gaps.push('no font files are mounted — a render would fall back and be off-brand')
  }
  if (!paths.some((p) => p.includes('/brain/brand/') && /\.(svg|png)$/.test(p))) {
    gaps.push('no brand assets are mounted — no logo could be placed')
  }
  if (!has('SKILL.md')) gaps.push('the skill is not mounted — the contract is absent')

  // An attached inspiration that was not mounted is worse than one never
  // attached: the request says it was consulted and the box never saw it.
  const mountedInspirations = paths.filter((p) => p.includes('/inspirations/')).length
  if (hydration.campaign.inspirations.length !== mountedInspirations) {
    gaps.push(
      `${hydration.campaign.inspirations.length} inspirations attached but ` +
        `${mountedInspirations} mounted`,
    )
  }

  if (hydration.task === 'edit') {
    if (!hydration.context.parent) gaps.push('an edit with no parent revision in context')
    else if (hydration.context.parent.tree.length === 0) {
      gaps.push('an edit whose parent revision has an empty tree')
    }
    if (!hydration.edit_instruction) gaps.push('an edit with no instruction to act on')
  }

  if (hydration.canvases.every((c) => !c.producible)) {
    gaps.push('no canvas is producible — the run has nothing it could make')
  }

  return gaps
}
