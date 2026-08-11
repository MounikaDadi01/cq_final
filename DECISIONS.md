# Decisions

What I built, how it holds together, what I deliberately left out, and what I would do
next. `ROADMAP.md` is the long argument for each choice; this is the short one, plus the
four questions the brief routes here rather than to code.

---

## No disqualifier is hit

All six are checked, and five of them are checked by code that runs on every test run.
`eval/tests/disqualifiers.test.ts` — 36 assertions — scans 81 production files and each
scanner is first fed a planted violation, so a green run means it looked rather than that
it found nothing. It asserts a floor on the number of files read, so a renamed directory
turns the suite red instead of quietly making it vacuous.

| Disqualifier | How this system answers it | Checked by |
|---|---|---|
| Anything other than the agent moves work out of the box | The agent saves its own work through `save_work`. Nothing reads a sandbox filesystem, ever. | `scanNoSandboxFilesystemReads` — 0 hits |
| A Kahua box and an Emplifi box | Templates are `cq-generation` and `cq-deployment`. No sandbox name, metadata or environment variable carries a tenant, a kit id or a task. | `validateSandboxIdentity` |
| The backend launching the agent as a subprocess | The backend spawns a **launcher**, which provisions a remote E2B box. The agent runs there. `web/package.json` carries no agent runtime. | `scanNoLocalProcessSpawning`, `scanNoAgentRuntimeDependency` |
| Any agent run on a laptop | Both agents only exist inside their images. No box creates a box. | asserted over the in-box tree |
| Work that exists only on a box | Bytes to storage before the row, every artifact durable the moment it is made. Kill a box and the work is already out. | `validateRunsSchema` |
| A hardcoded ordering | The queue is the `runs` table. Nothing anywhere encodes an arrival order. | proven by running the interleave, not by reading source |

The last one is deliberately not a static check — it cannot be settled by reading source,
only by running the interleaved case and observing that nothing crossed and nothing
waited. That run is below.

---

## The model, in one page

**Storage.** Two Supabase buckets and one Postgres database. `brains/` holds each
customer's brand kit — `DESIGN.md`, fonts, the asset manifest, the assets. `work/` holds
everything a run produces, keyed `<request-id>/rev-<n>/<relative-path>`. The relative path
*is* the identity: one tree goes into a box, the same tree comes out, and nothing
reconciles a flat key space against a nested one.

**Hydration.** A run gets one `hydration.json` naming what lands in the box, where each
file came from, the order to read things in, and — deliberately — what was withheld and
why. Three lifetimes are distinguished because they behave differently: `baked` (the
skill, the toolkit — identical every run, in the image), `kit` (the brain, pulled fresh
per run), `job` (this request, its copy, its comments, its parent revision). That split is
what makes a rebrand a data change rather than a rebuild, and it is why a third brand
needs no code.

**Save-out.** `save_work` uploads bytes first and records the row second. An object with
no row is an orphan — invisible, harmless, cleanable. A row with no bytes is a lie the
rest of the system believes, and something downstream will try to publish it. Saving is
append-only and asks the database what this revision already holds, so re-running a
partly-finished revision adds rather than duplicates.

**Isolation.** Row-level security, denying by default — a table with no policy is
unreachable rather than open. Each run carries a short-lived JWT of
`{ role, run_id, revision_id, brand_kit_id }`, and policies turn those claims into hard
limits: brand assets readable only for the run's own kit, artifacts insertable only
against its own revision, storage scoped by prefix. Isolation lives where the data lives
instead of in a wrapper around it, which is what makes the cross-tenant guarantee a SQL
assertion rather than a green tick. `service_role` bypasses RLS entirely and never leaves
the backend's `.env`; that is asserted at launch, not left to habit.

**Two roles, deliberately asymmetric.** `sandbox_run` may write renders and never a
recording. `sandbox_deploy` may write a recording and its own report and never a render.
A box that can publish cannot invent the work it publishes.

**Resume.** Always a fresh box, never a revived one — sandbox pause/resume is not used at
all, because the behaviour that matters is *kill the box, spin a new one, rehydrate*, and
reviving a paused box would demonstrate nothing. State lives in Postgres and object
storage, so a killed box loses no saved work, and an append-only save means a retry
resumes rather than duplicates.

**Surviving an unannounced kill.** A box is deleted the moment its run ends, and a kill
gives it no chance to write anything on the way out — so a transcript assembled in memory
and saved at the end is precisely the transcript you do not have when you need it, because
the runs worth reading are the ones that died. The run's account of itself is therefore
made durable *while it is still running*, flushed on a thirty-second timer, and what has
been flushed is already safe.

Two details in that carry the reasoning. It writes **numbered segments** rather than one
growing file, because `save_work` is append-only: a single `transcript.jsonl` re-saved
every thirty seconds would persist its first thirty seconds and silently discard
everything after. And the flush is scoped with `--only transcript`, because a bare save
would sweep up whatever else is new in the tree — a PNG caught half-written would be
stored and filed as a finished `render`, and append-only means that row could never be
corrected. **The debugging tool must not be able to publish a corrupt ad.**

Secrets are scrubbed by key name rather than by content, and signed URLs keep their path
and lose their query, because knowing *which* artifact was fetched is most of the value of
the line. Nothing in it can throw: a transcript that breaks the run it is describing is
worse than no transcript, and this is the one component whose failure must not cost a
render that has already been paid for.

---

## The four routed questions

### 1. The brand changes between revision three and revision six

The kit is pulled fresh every run, so revision six renders in the new brand while one
through five carry the old one. Both are correct records of what the brand was when they
were made.

**What I would add is a stamp, not a version graph:** record the kit's content digest on
the revision at hydration time — one column — so any two revisions can be compared and the
system can say *the brand changed between these*. Then, on an edit whose parent was
rendered against a different digest, surface it as a choice rather than continuing
silently: re-render the lineage against the new brand, or pin this edit to the old one.

The reason to stop there is that the expensive part was never storing versions — it is
deciding what a half-migrated campaign means. A digest makes the question askable for the
cost of a column and leaves answering it to someone with context the system does not have.
A version graph would be time not spent finishing.

### 2. Stale pins when the asset regenerates

Pins are built, as regions rather than points, stored as canvas fractions with a database
constraint that all four coordinates are present or all four are null — so "about this
corner" and "about the whole asset" stay distinguishable rather than collapsing into each
other.

**A pin binds to its revision and never moves.** A pin on rev 3 stays a true statement
about rev 3 forever; it is a record of what somebody said about a thing they were looking
at. When rev 4 lands, pins carry forward as open and unanchored: the text still applies,
the coordinates no longer do, and the interface says so rather than drawing a box over the
wrong pixels.

I rejected re-anchoring — tracking the commented element across a regeneration — for one
reason: it works until it doesn't, and when it fails it fails *silently*, by confidently
pointing at the wrong thing. A pin that admits it lost its anchor is worth more than one
that guesses. Resolution stays manual, because "did the agent address this" is a judgement
an operator makes better than a heuristic.

Today pins belong to their revision and older ones sit behind a toggle; the unanchored
carry-forward is the part I would build next.

### 3. The concurrency cap, and the fourth request

**The cap is a number and the queue is the `runs` table.** A dispatcher claims work with
`SELECT ... WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED`, limited to
the cap minus the current `running` count. The fourth request is a row that stays
`queued` until a slot frees — not lost, not held in memory, and it survives the backend
restarting.

**No scheduler**, deliberately: `SKIP LOCKED` gives correct claim semantics under
concurrent dispatchers for free, and building more would be answering a question nobody
asked. **No queue service** either — its three jobs here are enforcing the cap, making
pending work durable, and reclaiming stalled runs, all of which the run table and provider
liveness already do. Running both would create two sources of truth about whether a run is
pending, and they would disagree.

Liveness comes from asking E2B whether a box exists, which is authoritative, rather than
from an in-box heartbeat that only ever proves the box was alive some seconds ago. Asking
the provider whether a machine exists is a question about infrastructure, not a read of
the box's filesystem.

### 4. The blast radius of the agent's credentials

| Credential | Reach |
|---|---|
| `CQ_RUN_TOKEN` | One revision. Reads this kit's brand rows, inserts artifacts against this revision, reads and writes storage under `<request>/rev-<n>/`. Expires in 20 minutes. |
| `SUPABASE_ANON_KEY` | Nothing on its own. It identifies the project; RLS denies by default. |
| `OPENAI_API_KEY` | Full account. Bounded by a per-run cap on image calls and the sandbox timeout. |
| `DEPLOY_USERNAME` / `DEPLOY_PASSWORD` | The marketing tool, deploy boxes only. |

**A compromised generation box can spend money and cannot reach another tenant.** That
asymmetry is the design. Cross-tenant reads are structurally impossible rather than merely
forbidden, and the run token is scoped tightly enough that a hostile agent inside the box
has nothing to pivot to. `service_role` is never present, checked at launch.

The deploy box is the sharper edge, because it holds credentials to a system whose actions
we cannot reverse — a published ad has to be found by a person before it can be removed.
Which is why the deploy agent's bias is to stop rather than guess, why it may write only
`recording` and `result` artifacts and never a `render`, and why every deploy is on video.

Whatever sits in a box's environment is visible to the sandbox provider by construction.
That is why the run JWT is short-lived and scoped to a single revision, and why
`service_role` never goes near a box.

---

## What I built

**Generation.** Brand resolved from the brain, plate generated through the images API,
copy overlaid as live selectable HTML, rendered per canvas — for both brands. The model
looks at what it made before anything calls itself done, which is what catches the case
rule-checking never will: copy the same colour as the plate behind it satisfies every rule
in `SKILL.md` and is worth nothing.

**The engine.** Hydration, save-out, RLS isolation, and the interleaved concurrent case:
Emplifi opens a task, Kahua opens one, Kahua edits theirs, Emplifi edits theirs, Emplifi
opens a second — five real requests through the product's own HTTP API as two signed-in
customers, five real sandboxes, two in flight at once. Everything is read back out of
Supabase afterwards rather than trusted from the launcher's output, because the question is
what actually landed. Separate hydration files per tenant are kept for diffing. Three
recorded runs sit under `results/`, and concurrency has since been exercised repeatedly
through the UI with several boxes at once.

**A feedback surface.** Pinned regions round-tripping to the agent, attached to the right
revision of the right task of the right tenant.

**Run transcripts that survive the box.** Both agents write their own account as they go
and flush it to durable storage every thirty seconds, in segments, so a run killed
mid-form leaves evidence rather than nothing. Described above.

**Deployment.** A browser inside the box driving Adstream: sign in, three-step create
flow, upload, publish, confirm in the tool's own list, session recorded on video. One ad
per canvas — three ads, each confirmed by name in the list, from a deploy fired in the
front end.

**An evaluation layer that points at the truth.** 297 offline tests, plus 62 against a
live database (`npm run test:isolation`) covering row-level security, cross-customer
isolation and storage isolation — including the packet's own mis-tagged asset used as a
planted leak the wrong tenant must not see. Software keeps the checks with exact answers;
brand conformance is judged by the model looking at the rendered PNG, because that is the
artifact the customer actually sees.

## What I deliberately did not build

- **Brand-kit version graphs and rollback** — out of scope per the brief; the digest stamp
  above is the cheap version of the useful part.
- **A classifier deciding edit type.** Whether an edit is a text change or a full plate
  regeneration is the model's call, and it is good at it.
- **Software that grades brand conformance.** That is exactly where software fails, and
  the model reading the PNG is the better instrument.
- **A scheduler, and a queue service.** Covered above.
- **728x90.** The canvas is skipped and reported as a finding carrying the arithmetic,
  rather than failing at run time — two independent constraint failures, and no available
  model emits anything that wide. Confirmed as a deliberately planted bug and cleared to
  skip. Three canvases ship, and the campaign that asks for all four exercises exactly this
  path, which is why it exists.
- **Optimisation of any kind.** Cold starts are sub-second.

## What I would do next, in order

1. **Hand the agent the list of artifacts already durable.** Work already survives a
   killed box, and an append-only save means a retry resumes rather than duplicates. The
   refinement is telling the agent *which* plates already exist so it skips regenerating an
   image that has already been paid for. The launcher queries this revision's artifacts
   already, so this is passing that list into hydration and treating it as read-only.
2. **Kit digest on the revision**, per question 1 — one column, and the
   brand-changed-mid-campaign question becomes askable.
3. **Unanchored pin carry-forward**, per question 2.

---

## The claims I am least sure of

Two, both measured rather than felt.

**Deploy turn budgets beyond four canvases.** The deploy agent's ceiling is
`25 + 40 × canvases`. That came from counting turns in a real run: one ad through
Adstream's three-step flow costs about twenty-five turns, so three ads is roughly
sixty-five against a budget of a hundred and forty-five. Three canvases is proven and four
has the same headroom. Past that the constraint stops being turns and becomes wall clock
against the sandbox timeout, and the answer there is one canvas per box. I have not
measured where that line actually falls.

**The reclaim path under a dead supervisor.** Isolation is settled — it is enforced in SQL
rather than in code I wrote, and 62 assertions exercise it against a live database. The
concurrency cap is settled by the interleave and by running several boxes at once. What is
reasoned rather than forced is the case where an agent hangs *and* its supervisor dies with
it: detection then waits for the sandbox timeout rather than a heartbeat, so a slot is held
for minutes rather than seconds. It is bounded, because the timeout is set explicitly, and
I have not deliberately crashed one to time it.
