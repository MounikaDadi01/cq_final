# Decisions

What I built, what I stubbed, what I would do next, and which of my claims I trust
least. `ROADMAP.md` is the long argument for the architecture; this is the short one,
plus the four questions the brief routes here rather than to code.

---

## The model, in one page

**Storage.** Two Supabase buckets and one Postgres database. `brains/` holds each
customer's brand kit — `DESIGN.md`, fonts, the asset manifest, the assets themselves.
`work/` holds everything a run produces, keyed `<request-id>/rev-<n>/<relative-path>`.
The relative path *is* the identity: one tree goes into a box, the same tree comes out,
and nothing reconciles a flat key space against a nested one.

**Hydration.** A run gets one `hydration.json`. It names what lands in the box, where
each file came from, the order to read things in, and — deliberately — what was
withheld and why. Three lifetimes are distinguished because they behave differently:
`baked` (the skill, the toolkit — identical every run, in the image), `kit` (the brain,
pulled fresh per run), and `job` (this request, its copy, its comments, its parent
revision). A rebrand changes `kit` data and needs no rebuild; that is the constraint the
split exists to satisfy.

**Save-out.** The agent saves its own work with `save_work`, which uploads bytes first
and records the row second. An object with no row is an orphan — invisible and
cleanable. A row with no bytes is a lie the rest of the system believes. Nothing else
ever moves work out of a box: no backend collecting files, no out-directory sync, no
reading the sandbox filesystem after a run.

**Resume — and this one is half built, so read it carefully.**

What *is* true: a run is always a fresh box, never a revived one. Sandbox pause/resume is
not used at all, deliberately, because the behaviour the brief tests is *kill the box,
spin a new one, rehydrate* and reviving a paused box would demonstrate nothing. Saving is
append-only: `save_work` asks the database what this revision already has and skips it, so
re-running a partly-finished revision reports `N already recorded` and re-uploads nothing.
State lives in Postgres and object storage, so killing a box loses no work that was saved.

What is **not** built: there is no `resume.already_durable[]` in the hydration file. The
design called for one — the list of artifacts a previous attempt verified, handed to the
agent so it cannot regenerate them — and it was never implemented. The consequence is
specific and costs money: a resumed run re-enters a box that does not know which plates
already exist, so a successful `gpt-image-2` call that was already billed can be billed
again. `save_work` then declines to overwrite the artifact, which keeps the *record*
correct while the spend has already happened.

So the honest claim is: **work survives a killed box; billing does not.** Closing it is
small — the launcher already queries this revision's artifacts, so it is a matter of
passing that list into hydration and having the agent treat it as read-only. I did not do
it, and I would do it before claiming resume works.

**Isolation.** Row-level security, denying by default. The backend mints a short-lived
JWT per run carrying `{ role, run_id, revision_id, brand_kit_id }`, and policies turn
those claims into hard limits: brand assets readable only for the run's own kit,
artifacts insertable only against the run's own revision, storage scoped by prefix.
Isolation lives where the data lives rather than in a wrapper around it, which makes the
cross-tenant test a SQL-level assertion instead of a green tick. `service_role` bypasses
RLS entirely and never leaves the backend's `.env`.

---

## The four routed questions

### 1. The brand changes between revision three and revision six

**What happens today:** the kit is pulled fresh every run, so revision six silently
renders in the new brand while revisions one to five carry the old one. Nothing records
that the ground moved. A side-by-side of rev 3 and rev 6 shows two different brands and
nothing explains why.

**What I think is right:** stamp, don't version. Record the kit's content digest on the
revision at hydration time — one column, no version graph — so any two revisions can be
compared and the system can say *"the brand changed between these"*. Then, on an edit
whose parent was rendered against a different digest, refuse to silently continue:
surface it to the operator as a choice between re-rendering the lineage against the new
brand and pinning this edit to the old one.

The reason I would not build the version graph the brief warns against: the expensive
part is not storing versions, it is deciding what a half-migrated campaign means. The
digest stamp makes the question *askable* for the cost of a column, and leaves answering
it to a human who has context I do not.

**Least certain:** that operators want to be asked. It is plausible they would rather the
newest brand always win and never see a prompt. I have no evidence either way.

### 2. Stale pins when the asset regenerates

Pins are built — regions, not points. A comment stores `region_x/y/w/h` as fractions of
the canvas, with a database constraint that all four are present or all four are null, so
"a comment about the whole asset" and "a comment about this corner" are distinguishable
rather than conflated.

**The problem:** a region is coordinates against an image that no longer exists. Rev 4
moves the headline, and a pin drawn on the headline in rev 3 now points at whitespace.

**My answer: pins bind to a revision, not to a campaign, and never move.** A pin on rev 3
stays a true statement about rev 3 forever — it is a record of what somebody said about a
thing they were looking at. When rev 4 lands, its pins are carried forward as *open and
unanchored*: the text still applies, the coordinates no longer do, and the UI says so
rather than drawing a box over the wrong pixels.

I rejected re-anchoring — tracking the commented element across a regeneration — for a
specific reason: it works until it doesn't, and when it fails it fails *silently*, by
confidently pointing at the wrong thing. A pin that admits it lost its anchor is more
useful than one that guesses. Resolution stays manual, because "did the agent address
this" is a judgement the operator is better at than a heuristic.

**Stubbed:** the carry-forward is not implemented. Today's pins simply belong to their
revision and older ones are hidden behind a toggle.

### 3. The concurrency cap, and the fourth request

**The cap is a number, and the queue is the `runs` table.** A dispatcher claims work with
`SELECT ... WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED`, limited to
the cap minus the current `running` count. The fourth request is a row that stays
`queued` until a slot frees. It is not lost, not held in memory, and survives the backend
restarting.

**There is no scheduler**, deliberately. The brief is explicit that building one is
answering a question nobody asked. `SKIP LOCKED` gives correct claim semantics under
concurrent dispatchers for free.

**No queue service either.** Its three jobs here — enforcing the cap, making pending work
durable, reclaiming stalled runs — are already done by the run table and by asking the
sandbox provider whether a box is alive. Running both would mean two sources of truth
about whether a run is pending, and they would disagree.

**Least certain:** the reclaim path. If the agent hangs *and* its supervisor dies with it,
detection waits for the sandbox timeout rather than a heartbeat — minutes, not seconds,
during which a slot is held. Bounded, because the timeout is set explicitly, but slower
than I would like and not something I have deliberately crashed to measure.

### 4. The blast radius of the agent's credentials

What is in a box, and what each thing reaches:

| Credential | Reach |
|---|---|
| `CQ_RUN_TOKEN` | One revision. Read this kit's brand rows; insert artifacts against this revision; read/write storage under `<request>/rev-<n>/`. Expires in 20 minutes. |
| `SUPABASE_ANON_KEY` | Nothing on its own — it identifies the project, and RLS denies by default. |
| `OPENAI_API_KEY` | **Full account.** The real exposure. |
| `DEPLOY_USERNAME` / `DEPLOY_PASSWORD` | The marketing tool, deploy boxes only. Can create and publish ads. |

**So: a compromised generation box can spend money, and cannot reach another tenant.**
That asymmetry is deliberate. Cross-tenant reads are prevented structurally by RLS, and
the run token is scoped so tightly that even a fully hostile agent inside the box has
nothing to pivot to. `service_role` is never present, which is checked at launch rather
than left to habit.

The OpenAI key is the honest gap. It is a full-power key because the images API has no
scoped-key model worth the name; the mitigations are a cap on image calls per run and a
sandbox timeout, both of which bound spend rather than prevent it.

**The deploy box is the sharper edge**, because it holds credentials to a system where
actions are *not* reversible by us — a published ad has to be found by a person before it
can be removed. Which is why the deploy agent's bias is to stop rather than guess, why
it may only write artifacts with role `recording` or `result` (never `render`, so it
cannot manufacture the work it was asked to publish), and why every deploy is recorded on
video.

**Least certain:** that E2B cannot read a box's environment. Anything in a sandbox
environment is visible to the provider by construction. The run JWT being short-lived and
narrowly scoped is what makes that survivable; the OpenAI key is not protected from it at
all.

---

## What I built

- **Generation.** Brand resolution from the brain, plate generation through the images
  API, copy overlaid as live HTML, rendered per canvas. Both brands, four sizes.
- **The engine.** Hydration, save-out, RLS isolation, resume from a fresh box, the
  interleaved concurrent case with evidence nothing crossed.
- **A feedback surface.** Pinned comments as regions, round-tripping to the agent
  attached to the right revision of the right task of the right tenant.
- **Deployment.** A browser in the box driving Adstream: sign in, create flow, upload,
  publish, confirm in the list, session recorded on video. One ad per canvas.
- **An evaluation layer.** Brand acceptance tests, plate pipeline tests, RLS and
  tenant-isolation assertions against a live database, and static scanners for every
  disqualifier that has an exact answer — each proven against a planted violation.

## What I stubbed

- **Pin carry-forward across revisions** — answered above, not implemented.
- **Brand-change detection between revisions** — no kit digest on the revision, so a
  mid-campaign rebrand is invisible.
- **Per-ad detail-page verification on deploy.** The list confirms an ad exists by name;
  the ad's own detail page is not read back per canvas. This is the weakest link in the
  system and is described below.
- **`resume.already_durable[]`** — described above. Work survives a killed box; a
  re-billed image call does not.
- **728x90.** The canvas is skipped and reported as a finding carrying the arithmetic,
  rather than failing at run time. Two independent constraint failures, and no available
  model emits anything that wide — confirmed as a deliberately planted bug and cleared to
  skip. Three canvases ship; the campaign that asks for all four exercises exactly this
  path, which is why it exists.
- **Brand-kit versioning and rollback** — explicitly out of scope per the brief.

## What I would do next, in order

1. **Verify each ad on its own detail page.** See below — this is the one I would fix
   before anything else.
2. Point the repository disqualifier scan at the trees that actually exist. It currently
   scans `app/`, `api/` and `src/`, none of which are present, so it passes by reading
   nothing — the exact failure the brief names. The scanners themselves are proven
   against planted violations; only the target list is wrong.
3. Kit digest on the revision, per question 1.
4. Deliberately kill a box at minute nine, repeatedly, and write down which states a
   retry recovers and which need a human with database access. I have reasoned about
   this more than I have measured it.

---

## The claims I am least sure of

**First, the one that matters most.** A deploy is currently recorded as `published` on
the strength of the ad's *name* appearing in the tool's list. The ad's own detail page is
not read back per canvas, and in the last run `verified_url` was the list URL — which
contains no ad id and is identical for every deploy that will ever run.

This bit immediately. A three-ad deploy reported an anomaly on the third —
`No image stored for seeded ad` — and it is **still unresolved**, because the agent had
navigated to a pre-existing fixture row rather than the ad it created, and nothing in the
system could tell the difference. So the honest status of that third ad is: exists in the
list, creative never verified.

The brief says the detail page is the only place the truth lives, and it is right. The fix
is to capture each row's own `href` at the moment the list match succeeds, open that page,
confirm the image resolved, and refuse `published` if any canvas fails. I know what to do
and had not done it at the time of writing.

**Second: that the generated ads are actually good.** The pipeline satisfies every rule in
`SKILL.md` and has the model look at what it made before calling it done, which catches
the copy-on-same-colour-plate case that rule-checking never would. But "on-brand" is a
judgement I have been making about my own output, and I am the worst-placed person to
make it.

**Third: the untested edges of concurrency.** The interleaved case runs and nothing
crosses. I am confident about isolation because it is enforced in SQL rather than in code
I wrote. I am less confident about the cap under a dispatcher that dies mid-claim, which I
have reasoned through but not forced.

**Fourth: turn budgets.** The deploy agent's ceiling is now `25 + 40 × canvases`, derived
from counting turns in a failed run rather than from many successful ones. It is
comfortable at three canvases and I believe it holds at four; beyond that I would publish
one canvas per box, and I have not tested where the real line is.
