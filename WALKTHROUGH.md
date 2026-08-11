# Walkthrough

How the system fits together, in the order you would meet it. Every claim here points at a
file you can open or a command you can run.

---

## The one idea

Everything is a file system. Files and skills, hydrated in different orders at different
times.

Every event in this system is the same event: **a clean box spins up, the right files go
in, an agent gets a prompt, the agent works, the agent saves its own work, the box dies.**
Generating an ad is that event. Editing it the next day is that event. Deploying it into a
marketing tool is that event. There is no second subsystem anywhere — deployment differs
from generation by a browser, a credential and a different instruction, and nothing else.

If you only look at one thing, look at **hydration and save-out**. Everything else falls
out of those two.

---

## The shape

```
    Browser                Backend                     Sandbox (E2B)
  ┌──────────┐        ┌────────────────┐            ┌──────────────────┐
  │ intake   │        │ Next.js API    │            │  agent + skill   │
  │ review   │──────▶ │ mints run JWT  │──launch──▶ │  reads brain     │
  │ deploy   │        │ writes rows    │            │  makes the work  │
  └──────────┘        └────────────────┘            │  save_work ──┐   │
        ▲                     │                     └──────────────┼───┘
        │                     ▼                                    │
        │            ┌──────────────────┐                          │
        └────────────│    Supabase      │◀─────────────────────────┘
                     │ Postgres + RLS   │   the agent writes its own
                     │ brains/ · work/  │   work out. Nothing reaches in.
                     └──────────────────┘
```

The arrow that does **not** exist is the important one: nothing ever reaches into a
sandbox to collect files. The only path out of a box is the agent choosing to save.

---

## 1. The brand goes in

`eval/scripts/ingest-to-supabase.ts` reads a brain — `DESIGN.md`, fonts, the asset
manifest, the assets — and lands it in the `brains/` bucket and the brand tables.

The packet's brand data is not internally consistent, and finding that was part of the
job. Four kinds of problem, not one list:

- **True conflicts** — two sources, one field, different values. Kahua's h1 is 56px in the
  type scale and 48px in its own prose. Picked, written down, moved on.
- **Broken references** — a font named but not shipped, a logo the manifest points at that
  isn't there.
- **Cross-tenant contamination** — an asset tagged to one kit, filed in another brand's
  folder. This one is load-bearing: it is used as a **planted leak** the isolation suite
  must catch.
- **Shape differences** — the two brains simply describe themselves differently.

The resolution that matters structurally: `tokens.json` is a cache that disagrees with
`DESIGN.md` and is *newer* than it, so anything resolving by recency picks the wrong value.
It is **never hydrated**. The safest way not to consult a file is for it not to be in the
box, and `hydration.json` records that it was withheld and why.

## 2. A request becomes a run

Intake composes a request: brand kit, campaign copy, canvases, and inspirations chosen as
their own step. `web/app/api/run/route.ts` writes the rows; the launcher does the rest.

`eval/scripts/launch-run.ts` mints a short-lived JWT carrying
`{ role: 'sandbox_run', run_id, revision_id, brand_kit_id }`, builds the hydration file,
and creates a box. Three assertions run before anything starts: no `service_role` in the
environment, no high-entropy secret anywhere in the hydration file, and no field in it that
looks like it holds a credential.

**The box's identity says nothing.** Template `cq-generation`, no name, no metadata, and an
environment carrying an opaque run id. A Kahua box and an Emplifi box would be a
disqualifier; there is only a *run* box.

## 3. Hydration — the centre of it

`eval/src/hydration.ts`. One file per run, naming what lands in the box, where each thing
came from, **the order to read it in**, and what was deliberately withheld.

Three lifetimes, because they behave differently:

| Lifetime | What | How it gets in |
|---|---|---|
| `baked` | the skill, the toolkit | in the image, identical every run |
| `kit` | the brain | pulled fresh per run from `brains/` |
| `job` | the request, its copy, its comments, the parent revision | written for this run only |

That split is the answer to two of the brief's tests at once. **A rebrand is a data change,
not a rebuild**, because the brand is `kit`. And **a third brand needs no code**, because
nothing is resolved by name — every brand-specific value arrives as data resolved from the
request's kit id. A hydration file that mentioned a brand would be a bug even if it
happened to work.

Ordering is declared in the file rather than left to whatever order the code happens to
read things in — that is the hardcoded ordering the brief disqualifies.

## 4. The agent works

`sandbox/agent.generate.ts`, following `.claude/skills/design-generation/SKILL.md` — the
same bytes a developer invokes locally, mounted as a skill rather than paraphrased into a
prompt, so there is one source of truth for the contract.

Plate first, one plate per canvas size, never cropped or re-framed. Every word live and
selectable in HTML. Logos at their natural proportions. `DESIGN.md` outranks every other
artifact.

Then the part rules cannot do: **the model looks at what it made.** An ad whose copy is the
same colour as the plate behind it satisfies every rule in `SKILL.md` and is worth nothing.
Software keeps the checks with exact answers — dimensions, byte counts, logo geometry — and
the model judges the rendered PNG, because that is the artifact the customer actually sees.
A check that reads the HTML while the customer sees a PNG has verified a file nobody looks
at, and the two drift apart without either one looking wrong.

**728x90** cannot be produced: two independent constraint failures, and no available model
emits anything that wide. It is reported as a finding carrying the arithmetic rather than
failing at run time. Three canvases ship.

## 5. The agent saves its own work

`sandbox/save_work.mjs`, and this is the durability story in one rule:

**Bytes first, row second.** An object with no row is an orphan — invisible, harmless,
cleanable. A row with no bytes is a lie the rest of the system believes, and something
downstream will try to publish it.

Saving is append-only and asks the database what this revision already holds, so a retry
adds rather than duplicates. When a save fails it fails loudly, in words the agent can read
and act on in the same run — not in a way somebody discovers on Thursday.

The tree in is the tree out: the relative path *is* the identity, stored under
`work/<request-id>/rev-<n>/`, so nothing reconciles a flat key space against a nested one.

## 6. Isolation is a database rule

`supabase/migrations/` — 17 of them. Every table has RLS enabled and **denies by default**:
a table with no policy is unreachable, not open.

| Table or bucket | Policy |
|---|---|
| `brand_assets`, `brand_fonts` | `SELECT` only where `kit_id = jwt.brand_kit_id` |
| `artifacts` | `INSERT` only where `revision_id = jwt.revision_id` |
| `runs` | `UPDATE` only its own row |
| `storage.objects` in `work` | read and write only under `<request>/rev-<n>/` |
| everything else | no policy, therefore no access |

Two sandbox roles, deliberately asymmetric. `sandbox_run` writes renders and **never** a
recording. `sandbox_deploy` writes a recording and its own report and **never** a render —
so a box that can publish cannot invent the work it publishes.

`service_role` bypasses RLS entirely. It stays in the backend's `.env`, never in a box,
never in a hydration file, never in a log, and that is asserted at launch rather than left
to habit.

**The cross-tenant leak is a SQL question, not a code question.** The mis-tagged asset from
the packet sits in one brand's folder tagged to another kit; an Emplifi run carries an
Emplifi kit id, so the row is simply not visible. That is much harder to fake than a green
tick.

## 7. The human iterates

`web/app/review/` — pinned regions, not points. A comment stores `region_x/y/w/h` as
fractions of the canvas, with a database constraint that all four are present or all four
are null, so "about this corner" and "about the whole asset" stay distinguishable.

The graded part is not the routing. Whether an edit is a text change or a full plate
regeneration is the model's decision and it is good at it — there is no classifier. What
matters is that the comment **hydrates**: right tenant, right task, right revision, right
coordinates, and a prompt that carries what the human meant. The edit is a new revision
with the parent's tree mounted, so the agent sees what exists before changing it.

## 8. It deploys

`sandbox/agent.deploy.ts`, in its own box, from its own template, as its own Postgres role.
Same event as everything else — plus a browser, credentials and a different instruction.

Sign in, three-step create flow, upload the creative, publish. **One ad per canvas**,
because the tool's creative step takes a single image: three canvases is three ads, named
so they are told apart in the list.

Then the part that decides whether it counts:

1. **Confirm in the list.** The confirmation screen is the tool *telling* you it worked;
   the list is the tool *showing* you. Only the second survives someone asking "where is it,
   then?" The list read waits out the six-second success toast — which does not clear on
   navigation and would otherwise confirm an ad by carrying its name onto the list page.
2. **The recording.** Playwright records the session and flushes on context close, before
   the run reports anything. No recording, no deploy.
3. **The outcome.** The agent's verdict is a **ceiling** — the launcher can confirm or
   downgrade it, never raise it. `published` requires both a recording and a url read back
   off the tool's own page. Anything else is `unverified`, however confidently the run
   finished, and a run that ends without reporting still files what it confirmed.

The Deploy screen is built around evidence rather than intent: every row shows whether a
recording exists and whether a url was read back, and you can watch the video.

---

## Concurrency, and the horrifying case

`eval/scripts/interleave-test.sh` runs the interleave for real — Emplifi opens a task,
Kahua opens one, Kahua edits theirs, Emplifi edits theirs, Emplifi opens a second — as five
real requests through the product's own HTTP API, as two signed-in customers, in five real
sandboxes, two in flight at once. Different inspirations in flight together, so two outputs
coming back looking like the same inspiration would show.

Everything is read back out of Supabase afterwards rather than trusted from the launcher's
output, because the question is what actually landed. Per-tenant hydration files are kept
so the two can be diffed. Three recorded runs sit under `results/`, and it has since been
exercised repeatedly through the UI with several boxes at once.

**The unit of isolation is the run, not the tenant** — which is both the non-disqualified
choice and the stronger one. Under per-tenant boxes, Emplifi's two simultaneous tasks would
share a box and could cross.

**The queue is the `runs` table.** A dispatcher claims work with `FOR UPDATE SKIP LOCKED`,
capped at a named number minus the running count. The fourth request is a row that stays
`queued`. No scheduler, and no queue service — running one alongside the run table would
create two sources of truth about whether a run is pending.

---

## How you know it works

```bash
npm test --prefix eval                 # 297 tests, offline
npm run test:isolation --prefix eval   # 62 tests against the live database
npm run e2e --prefix web               # 25 tests through the real interface
```

**297 offline**, across brand resolution, the plate pipeline, logo grounding, canvas
capability, hydration shape, the deploy verification rules, and the disqualifier scanners.

**62 against live Postgres and live storage** — row-level security, cross-customer
isolation, storage isolation, token expiry. This is the suite that proves one customer
cannot reach another's brand, and it includes the packet's mis-tagged asset as a planted
leak the wrong tenant must not see.

**25 through the product itself**, driving the real interface with Playwright: sign-in and
cross-customer isolation from the browser, the review screen's regions and the compose
panel, the deploy screen showing evidence rather than intent, and the API refusing what it
should — a forged session cookie, a revision id that is really a flag, an upload claiming
another customer, a path masquerading as a filename. Serial and single-worker, because the
suite reads shared state and a parallel race would surface as a product bug rather than a
scheduling one.

Both suites are built so that **a green run means they looked.** The isolation suites skip
themselves loudly, and say so in words, when they cannot connect — a suite that goes green
without connecting is the failure the whole layer exists to prevent. The disqualifier
scanners are each fed a planted violation, and the repository scan asserts a floor on the
number of files it read.

## The disqualifiers, answered

| Disqualifier | Answer | Evidence |
|---|---|---|
| Anything but the agent moves work out of a box | `save_work` is the only path out | `scanNoSandboxFilesystemReads` — 0 hits over 81 files |
| A Kahua box and an Emplifi box | `cq-generation` / `cq-deployment`, opaque run id, no tenant in name, metadata or environment | `validateSandboxIdentity` |
| The backend launching the agent as a subprocess | the backend spawns a *launcher*; the agent runs in a remote box; no agent runtime in `web/package.json` | `scanNoLocalProcessSpawning`, `scanNoAgentRuntimeDependency` |
| An agent on a laptop | both agents exist only inside their images; no box creates a box | asserted over the in-box tree |
| Work that exists only on a box | bytes durable before the row; kill a box and the work is already out | `validateRunsSchema` |
| A hardcoded ordering | the queue is a table; nothing encodes arrival order | the interleave, run for real |

---

## Where to look, by question

| If you want to know… | Open |
|---|---|
| what lands in a box, and why | `eval/src/hydration.ts` |
| how work gets out | `sandbox/save_work.mjs` |
| what stops one tenant reaching another | `supabase/migrations/0002_rls.sql`, `0005_run_role.sql`, `0006_deploy_role.sql` |
| the contract the ad must satisfy | `SKILL.md` |
| how a deploy proves itself | `sandbox/agent.deploy.ts`, `eval/src/deploy-fields.ts` |
| whether a disqualifier is hit | `eval/tests/disqualifiers.test.ts` |
| the reasoning behind any of it | `ROADMAP.md`, and `DECISIONS.md` for the short version |
