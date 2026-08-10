# Design engine — architecture and roadmap

Date: 2026-08-10

## What this is

A small version of CharacterQuilt: an agent that takes a customer's brand,
generates a designed ad, lets a human iterate on it, and pushes it into the
customer's marketing tool.

The governing idea, taken from the brief verbatim: **everything is a file
system — files and skills, hydrated in different orders at different times.**
Every event in the system is the same event: a clean box spins up, the right
files go in, an agent gets a prompt, the agent works, **the agent saves its own
work**, the box dies. Anything that deviates from this does not get built.

Hydration and storage are where the time goes. Everything else falls out of
them.

## Hard constraints

Any one of these ends the trial. They are design inputs, not review notes.

1. Only the agent moves work out of the box. No backend collecting files, no
   out-directory sync, no reading a sandbox filesystem after a run.
2. No box identity may say which tenant or task it serves.
3. The backend must not launch the agent as a subprocess on its own box.
   Queues are fine; co-location is not.
4. No agent runs on a laptop — especially the deploy agent.
5. No work exists only on a box. Kill the box mid-task and the state survives.
6. No hardcoded ordering. Requests arrive in any order.
7. A third brand goes through with zero code changes.

Also binding, from SKILL.md: plate-first, one plate per canvas size, never
cropped or re-framed; every word live selectable HTML; logos placed at natural
proportions; `DESIGN.md` outranks every other artifact; inspirations are
treatment reference only; the agent never claims publication.

## Stack

Every choice and the reason for it is in one table, under
[Everything we are using, and why](#everything-we-are-using-and-why). It is not
duplicated here — two lists of the same thing drift, and the annotated one is
strictly more useful.

Two properties of the shape are worth stating up front, because the rest of the
document leans on them.

Front end and backend run **locally**, in one process. The sandbox is the one
piece that must be remote, because the brief forbids the agent running on your
laptop — and that separation is exactly what keeps constraint 3 satisfied.

The consequence worth stating up front: **every connection in the system is
outbound.** The backend reaches E2B and Supabase; the agent reaches Supabase and
the model APIs. Nothing connects *in* to the machine running the backend, so there
is no tunnel, no public endpoint, and no edge to configure. The agent and the
backend never speak to each other; they meet in the database.

## Hydration

Three kinds of data go into a box. They look alike and are not.

| Lifetime | Contents | Path in |
|---|---|---|
| Same every run | SKILL.md, contracts, renderer, Playwright, fonts runtime, `save_work` script | Baked into the E2B template |
| Same per customer | The brain: `DESIGN.md`, `fonts/`, asset manifest, logos | Pulled fresh from S3 every run, never baked |
| One job | Request, copy, messages, revision lineage | `HYDRATION.md` written in at boot |

The brain is never baked. That is what makes a rebrand not need a rebuild.

**No caching, no download skipping, no cold-start tuning.** Baking assets in to
make a box start faster is an explicitly named road bump. Correctness is graded;
performance is not. Every run downloads every asset it needs, every time, even
when that is obviously wasteful.

### Arbitrary output, not four files

A request may ask for one ad or fifty, each at one canvas size or several. The
number of artifacts a run produces is decided by the request and the agent, not
by the schema: artifacts are rows created as they are ACKed, and the front end
renders whatever exists rather than a fixed grid. Nothing in the storage model,
the hydration file, or the UI assumes four of anything.

**The box boots holding only an opaque run id.** No tenant in its name, tags,
or metadata. It learns which brand it serves by reading the hydration file, then
pulls that brand's kit fresh. A box that already knows its tenant is the failure this
design exists to prevent.

Asset resolution filters on `brand_kit_id`, never on the folder a file happens
to sit in.

### The hydration file

One file per run, `HYDRATION.md`: YAML frontmatter carrying machine-checkable
run data, Markdown body carrying the prompt. It holds references and
instructions, never payloads — the brain, fonts, logos, inspirations and parent
artifacts arrive as presigned URLs with digests, which is what keeps "pulled
fresh every run" true.

Every field is a projection of a row. `brand.*` comes from `brand_kits` joined
to `brand_assets` on the run's kit; `job.canvases[]` from `request_canvases`, so
a fifth canvas size needs no code; `policy.*` from a global `policies` table
rather than per-customer branches. A brand inserted for the first time renders a
valid file immediately, which is how the third-brand test passes by
construction.

The rendered file is persisted to S3 at
`work/<task-id>/rev-<n>/HYDRATION.md`, byte-identical to what was written into
the box, as the run's replayable recipe. That is what makes resume a replay
rather than a reconstruction, and it is also the audit record of exactly what a
run was told.

### Exactly what lands in the box

The hydration file names references. These are the files that actually arrive,
and nothing else does:

| Source | Files | How |
|---|---|---|
| Baked in the template | `SKILL.md`, prompt preamble, renderer, Playwright + browsers, `save_work` script, Agent SDK | Built into the E2B image |
| Fetched per run | `brain/DESIGN.md` | Presigned, digest-checked |
| Fetched per run | `brain/brand/asset_manifest.json` | Presigned, digest-checked |
| Fetched per run | `brain/brand/*.svg` — **only** assets whose `kit_id` equals the run's kit | Filtered at render time |
| Fetched per run | `brain/fonts/*` — the whole directory for that kit | No filtering, no parsing |
| Fetched per run | `inspirations/*` — **only** filenames the request names | Empty list means none |
| Fetched per run (edits) | Parent plate and parent HTML for the canvases being edited | Synced from `rev-<n-1>/` to `/work/parent/` at the same relative paths |
| Written in | `HYDRATION.md` | Backend writes it via the E2B filesystem API |

Three filters do the real work, and each maps to a constraint:

- **Assets by `kit_id`, never by folder.** This is what stops the Kahua logo
  sitting in Emplifi's manifest from reaching an Emplifi box.
- **Inspirations only when named.** An inspiration that merely sits in a
  directory is not selected and must not influence the build, so the fetch list
  is built from the request's array, never from a bucket listing.
- **Fonts: the whole directory, unfiltered.** An earlier draft filtered fonts to
  the families `DESIGN.md` names, which would have required the backend to parse
  brand prose — fragile, and exactly where per-customer logic creeps into code.
  Four TTFs are small, they all belong to the same kit so there is no
  cross-tenant risk, and shipping the directory deletes the parsing entirely.

### The backend never reads DESIGN.md

`DESIGN.md` is shipped as a file and interpreted by the agent. No backend code
parses it, resolves its conflicts, or extracts values from it. This is the rule
that keeps brand knowledge out of the codebase, and it is what makes the
third-brand test structural rather than hopeful.

Conflicts are resolved by the agent under generic policy carried in the prompt
preamble — for example, *where `DESIGN.md`'s prose contradicts its own table,
the prose governs* — never by a branch that names a customer.

The same applies to font substitution. The policy is generic: **when a family
named in `DESIGN.md` has no matching file, fall back to the nearest family by
name prefix at the heaviest available weight, and record the substitution.**
That rule produces Barlow 700 for this packet's missing Barlow Condensed without
anything in the code knowing what Barlow is, and a third brand naming
"Foo Condensed" with only Foo shipped is handled by the same sentence.

**Enforced, not promised:** CI greps the source tree for tenant names and fails
the build on a hit outside fixtures and tests. That turns "no brand is
hardcoded" into evidence.

`brand/tokens.json` is deliberately **not** sent. It carries no authority, it is
not permitted to contribute a value `DESIGN.md` also states, and in this packet
it disagrees with `DESIGN.md` on three Emplifi values. Our tooling does not need
it, so omitting it removes a way to be wrong. Recorded in DECISIONS.md.

### When the file is regenerated

The hydration file is **immutable for the life of a run**. Anything that changes
what the agent should know produces a new run with a freshly rendered file, so a
run's recipe always matches what it actually did.

| Event | What happens |
|---|---|
| Operator sends a chat message | New run, new file, `messages` block populated |
| Retry after a crash | New run, new file, `resume.already_durable[]` reflects what is verified now |
| Resume after a kill | New run, new file; the agent picks up as if files were never deleted |
| Deploy | New run, `kind: deploy`, different credentials and prompt |
| Brand asset changes in S3 | Nothing to update — the next run's file is rendered fresh from current rows |
| `Save & exit` mid-run | No file change; a message goes to the live agent session |

The last two rows are the point. A rebrand needs no file regeneration because
nothing was ever frozen, and a wrap-up instruction is a message rather than a
mutation, so the recipe stays a faithful record.

### Edit awareness

The file states plainly whether the run is an edit, and carries the facts an
edit needs:

```yaml
run:
  kind: edit
edit:
  parent_revision: 3
  new_revision: 4
  copy_diff: {headline: {from: "...", to: "..."}}   # {} when copy is unchanged
  parent_artifacts: [{canvas: portrait, kind: plate, url: "...", sha256: "..."}]
messages:
  - {id: msg_01, canvas: portrait, author: "operator@…", body: "..."}
resume:
  already_durable: [{canvas: portrait, kind: plate, sha256: "...", url: "..."}]
```

These are **facts, not instructions**. The file says which copy fields differ,
which pins exist and where, and which parent artifacts are available for reuse.
It does not say whether to retypeset text or regenerate the plate — that is the
model's call, and the brief is explicit that no classifier gets built for it.

`resume.already_durable[]` is the one entry that *is* binding: anything listed
there has been verified in durable storage and must not be regenerated. That is
what makes a resumed run cheap and what stops a retry re-billing an image call
that already succeeded.

## Save-out

The agent moves its own work. Nothing else does.

### One tree, in and out

Everything is a file system, which means the thing that comes out has to be the
same shape as the thing that went in. Not a bucket of opaque keys with a database
holding the meaning — a directory tree, laid out the way the brain is laid out and
the way SKILL.md already names its output.

**The storage key is the relative path.** Nothing invents an identifier:

```
brains/<kit-id>/<path within the brain>
work/<task-id>/rev-<n>/<path within the project>
```

So `/work/html_portrait/assets/plate.png` lands at
`…/rev-4/html_portrait/assets/plate.png`, and never anywhere else. `save_work`
mirrors, it does not translate.

The work tree uses SKILL.md's own convention — *"Save each plate under
`html_<slug>/assets/`"* — rather than one we made up:

```
<task-id>/rev-4/
  HYDRATION.md              the recipe this revision was built from
  RESULT.json               the index of what it produced
  html_square/
    index.html
    assets/plate.png
  html_portrait/
    index.html
    assets/plate.png
  renders/
    square.png
    portrait.png
  recordings/
    deploy.webm
  transcript/
    session.jsonl
```

Inside the box, both trees land where their names say:

```
/work/
  HYDRATION.md
  brain/            an exact mirror of brains/<kit-id>/
  inspirations/     only the filenames the request names
  parent/           an exact mirror of rev-<n-1>/, on an edit
  html_<slug>/      the output, mirroring what gets saved
  renders/
  RESULT.json
```

Three things fall out of this, and they are the reason it is worth being strict
about:

- **Resume is a sync, not a reconstruction.** Rehydrating means copying a prefix
  back into `/work`. The layout is byte-identical, which is what makes "the agent
  picks up as if the files were never deleted" literally true rather than
  approximately true.
- **An edit is the same operation.** The parent revision syncs to `/work/parent/`
  by the same rule, at the same relative paths.
- **The bucket is browsable.** A task's history reads as directories, so a person
  can see what a revision contained without querying anything.

`RESULT.json` uses the same vocabulary as the manifest it faces across the
boundary — entries keyed by `kind` and `path`, exactly as `asset_manifest.json`
describes staged input. One index format going in, the same index format coming
out.

Write access is scoped to `work/<task-id>/rev-<n>/` by a row-level policy rather
than by a credential wrapper. One revision is produced by one run at a time, so
the blast radius stays a single prefix while the path itself stays addressable by
revision rather than by an opaque run id.

### `save_work` is the mechanism

The agent is given a script and told it exists. It decides when to run it and
what to pass. This is deliberately a plain executable rather than only a tool
call: it is inspectable by hand inside the box, which is how it gets debugged,
and it does not depend on MCP plumbing to function.

```
save_work --kind plate|render|html|recording|result \
          --canvas portrait \
          --path /work/html_portrait/assets/plate.png \
          [--revision 4] [--meta key=value ...]

save_work --kind render --glob '/work/out/*.png'
```

It documents itself through `--help`, accepts a glob so an arbitrary number of
outputs saves in one call, is idempotent by digest so a repeat is free, and exits
non-zero with a reason the agent can read and act on in the same run.

The `save_artifact` tool wraps the same code path so a failure also arrives as a
structured tool result. One implementation, two front doors — the script is the
one that matters.

**Cadence is the one place this differs from the camp it belongs to.** The obvious
shape is to generate everything and then save once. We save per artifact as each
one exists, and plates are saved before the tool returns them to the model,
because the brief's own failure case is a box killed at minute nine with a billed
image call already succeeded. Same actor, same mechanism, tighter cadence.

- The backend mints a short-lived JWT carrying `run_id`, `revision_id` and
  `brand_kit_id` claims, passed into the sandbox as environment. Row-level
  security turns those claims into the only rows and objects the run can touch.
  Blast radius is exactly one revision.
- The agent writes plates, rendered PNGs, HTML projects, its own transcript,
  browser recordings, and `RESULT.json`.
- After writing, the agent re-reads each object and compares size and digest
  against what it wrote. A mismatch fails loudly, in words, in the same run,
  while the agent can still fix it.
- Each ACK is the commit point for that artifact. There is no terminal file and
  no separate reconciliation queue: the row exists because the agent said so and
  the backend verified it.

The backend reads S3. It never reads the box. Saving work is not publishing,
and reading durable storage is not reaching into a sandbox.

There is no terminal manifest. Completion is a state transition on the run row,
written by the agent itself, so no single file can strand a run's output.

### `RESULT.json` is a report, not a mechanism

SKILL.md requires it — staged project paths, the rendered PNG per canvas size, a
completion or escalation status, and any brand value that could not be reconciled
together with what was used instead — so it gets written and saved like any other
artifact.

What it is not is load-bearing. Every artifact is durable and already has a row
before `RESULT.json` exists, so a box that dies before writing it strands
nothing. That is the difference between this and the method where a backend reads
a file to discover what a run produced.

The line that keeps it sharp: **the backend may read `RESULT.json` for its
content** — to show an operator the escalations — **but never for discovery.**
Reading durable storage is fine; depending on a file to know what exists is not.

### The sandbox never reaches the backend

The backend runs locally, so nothing can connect *to* it. That is a feature
rather than a limitation, because it means every connection in the system is
outbound:

```
backend (local)  ──▶  E2B          create the box, write HYDRATION.md in
agent   (E2B)    ──▶  Supabase     upload artifacts, insert rows
backend (local)  ──▶  Supabase     read everything back, reconcile
backend (local)  ──▶  E2B          ask whether the sandbox still exists
```

**No inbound connection to the machine running the backend, ever.** No tunnel, no
public endpoint, nothing to expose. The agent and the backend never speak; they
meet in the database.

That also removes the artifact ACK endpoint. The agent uploads an object and
inserts its row directly, and the *database* is what accepts or rejects — a
row-level policy, a `NOT NULL`, a uniqueness constraint. Postgres returns the
error text straight to the agent, so a bad save still fails loudly in words it
can read and fix in the same run, with no endpoint of ours to keep honest.

One honest regression. Independent verification used to be synchronous: an
endpoint re-read the object and compared the digest before writing the row. Now
the agent verifies its own upload in-run, and the backend re-verifies during
reconciliation. Immediate feedback stays; the *independent* check moves a few
seconds later.

### Surviving abrupt closure

E2B kills sandbox commands with SIGKILL, so no graceful signal arrives and no
exit handler is guaranteed to run. Any design that flushes work "on shutdown"
would lose data. Durability therefore has to be continuous, which is why
write-through is the primary path rather than a convenience.

Five layers, in order of what they protect:

1. **Save before return.** `generate_plate` uploads and ACKs the plate before
   handing it back to the model. The image call is billed the moment it
   succeeds, so the artifact is durable before the agent has even seen it. A box
   that dies one second later loses nothing billable.
2. **`PostToolUse` hook** checkpoints the working directory after each expensive
   step, capturing intermediate state that is not itself a deliverable — a
   half-built HTML project, a downloaded parent plate.
3. **`Stop` hook** blocks the agent from ending while any artifact is unsaved,
   returning `decision: "block"` so the run cannot finish quietly incomplete.
4. **`PreCompact` hook** archives the full transcript before the SDK summarises
   it, so long runs keep their history.
5. **Liveness, asked of the provider.** Every run row carries its
   `e2b_sandbox_id`, so the backend asks E2B whether the sandbox still exists. A
   sandbox that is gone while the run is not `completed` becomes `interrupted`.
   Everything already ACKed is reused on retry; anything unverified is
   regenerated.

An earlier draft used a periodic heartbeat from inside the box. Two signals
replace it and both are better. Asking the provider is *authoritative*, where a
heartbeat only ever proves the box was alive some seconds ago — and it needs no
in-box timer, so a busy run can never look dead because the model forgot to tick.
The supervisor reporting the agent's exit covers the one case liveness cannot: a
box still up with a dead agent inside it.

Asking E2B about sandbox lifecycle is not reading the box. It is a question to the
provider about whether a machine exists, which is a different thing from touching
its filesystem.

The honest cost: if the agent hangs *and* the supervisor dies with it, detection
waits for the sandbox timeout instead of a heartbeat interval — minutes rather
than seconds. With a small concurrency cap that holds a slot slightly longer, and
it is bounded, because the sandbox timeout is set explicitly.

**A box is never kept alive.** `lifecycle.onTimeout` is `kill`, and a completed
run's box is killed as soon as the agent's `finish_run` lands. Sandbox
pause and resume is not used at all.

An earlier draft configured pausing as a "soft landing" on timeout. That was
wrong on both counts. The behaviour the brief actually tests is *kill the box,
spin a new one, rehydrate* — so reviving a paused box demonstrates nothing, and
paused sandboxes are retained indefinitely, which is the "why don't we just keep
the box running" the brief rules out.

**Resume is always a fresh box.** It rehydrates from S3 and the run table, and
what makes it cheap is `resume.already_durable[]`: every artifact the previous
attempt verified is listed and must not be regenerated, so a successful image
call is never billed twice. Preserving what the agent already made is the
write-through ACK path's job, not a sandbox feature's.

## Brand data resolution

The packet holds eleven problems, and they are **four different kinds of
problem**. Collapsing them into one list is the mistake: only the first kind is
what the brief means by "not internally consistent", and only one item in it
needs a human to pick anything.

### Class 1 — true inconsistencies: two sources, one field, different values

These are what "pick a value, write it down, move on" is about.

| Conflict | Picked |
|---|---|
| **Kahua h1** — type scale 56px, its own prose 48px, cache 56px | **48px** |
| **Emplifi secondary** — `DESIGN.md` `#6765FE`, cache `#5B5BD6` | `DESIGN.md` |
| **Emplifi radius** — `DESIGN.md` 12px, cache 16px | `DESIGN.md` |
| **Emplifi h1** — `DESIGN.md` 48px, cache 56px | `DESIGN.md` |

**Three of the four resolve structurally.** `tokens.json` is never hydrated, so
for secondary, radius and h1 there is no competing value inside the box to
adjudicate — we picked `DESIGN.md` by not shipping the alternative. The trap is
that the cache was exported later (2026-07-28) than `DESIGN.md` was reviewed
(2026-04-02), so freshness argues for the file that has *"no authority"*.

**Only Kahua's h1 needs an actual judgment**, because both values live inside
`DESIGN.md` itself and withholding a file cannot fix that. Picked 48px: the prose
is as binding as the numbers and is the more specific statement. Which value wins
matters less than the pick being recorded and repeatable, so the resolution is
deterministic and a test asserts it comes out the same way twice.

### Class 2 — broken references: a pointer with nothing behind it

Nothing disagrees here; something is absent. SKILL.md already prescribes both.

| Reference | Answer |
|---|---|
| `kahua-logo-white.svg` listed as `logo_reverse`, no file | On a dark ground, prefer `logo_mark` — Kahua stages an orange hexagon with a white circle that reads on jobsite photography. If neither a reverse nor a symbol exists, **omit and escalate**. Never typeset a substitute, never borrow one. |
| Heading font "Barlow Condensed", only Barlow 400–700 shipped | **Barlow 700, tight tracking, at the specified size, with the copy cut to fit.** Kahua's own prose says it: *"If the headline does not fit at 48, cut the copy; do not scale the type."* Synthetically condensing a face with `transform: scaleX()` is exactly the distortion that sentence forbids. |

Both answers are generic. The logo rule is a preference order held as data —
`logo_reverse → logo_mark` on a dark ground, `logo → logo_mark` on a light one —
and in this packet one brand takes the first branch while the other takes the
second, from one sentence. The dark threshold is the exact luminance at which
white type outreads black, so software computes the ground and the agent decides
whether the logo survives it.

### Class 3 — cross-tenant contamination

`emplifi/brand/asset_manifest.json` lists `partner-lockup.svg` tagged
`brand_kit_id: "bk-kahua-2026"`, and that file *is* the Kahua logo — orange
hexagon, `aria-label="kahua"` — sitting inside Emplifi's brain folder. Resolving
assets by folder or by `kind` ships a competitor's mark on an Emplifi ad,
silently.

Not a value dispute; picking a value here would be nonsense. Three independent
gates: quarantined at ingest, filtered at hydration on `brand_kit_id`, rejected
at ACK. This asset is also the live fixture that proves the filter fires.

### Class 4 — shape differences between brands

**Consistent within each brain**, so there is nothing to pick — and the most
dangerous class, because it breaks code rather than asking for a decision.

| Field | Emplifi | Kahua |
|---|---|---|
| Palette | 6 keys, includes `secondary` | 5 keys, **no `secondary`** |
| Asset kinds | 4, includes `logo_lockup` | 3, **no `logo_lockup`** |

Kahua's `DESIGN.md` and its `tokens.json` agree on both, so neither is a conflict.
Any code reaching for `palette.secondary` or expecting a lockup works on one
brand and breaks on the other today, and would break on a third brand tomorrow
for a different key. Nothing may require an optional field: fall back within the
same brain, never invent. Tests assert it — a brain carrying only `primary` and
`surface` plans and checks cleanly.

Note that Emplifi's extra asset kind *is* the planted leak. The asymmetry and the
contamination are the same object.

### Not brand data at all

The two that look like the juiciest conflicts, and are the trap.

The Kahua inspiration uses a red CTA (~`#E4002B`) and a Hensel Phelps co-brand
lockup. The Emplifi inspiration shows a solid orange filled pill where
`DESIGN.md` says orange is never a fill and a CTA is an orange label inside a 2px
orange outline. **Neither is an inconsistency**, because an inspiration has no
authority — *"never a source of colour, type, spacing, radius or any other
token"*. An inspiration disagreeing with the brand is an inspiration doing what
inspirations do.

Separately, the Emplifi logo contains `#37B6E9`, which is not in the palette. It
is a placed asset, so it ships as-is and the colour is never promoted to a token.

## Handling worse brand data

Later brains will be more broken than this packet. Nothing below modifies a brand
file or SKILL.md: precedence comes from SKILL.md's own resolution order, and the
universal fallback is its own sentence — *"keep the invariant, take the allowed
alternative, and say in `RESULT.json` what you could not do."*

**Most curveballs cost nothing because we do not parse the brand.** A future
`## Motion` section, colours in Pantone, a scale in `rem`, prose rules nobody
anticipated — none of it touches our code, because `DESIGN.md` ships as a file and
the agent interprets it. Our entire machine-readable surface is three narrow
things: the kit id from the manifest, asset paths with their kit ids, and font
filenames.

### Three outcomes, not two

`unverifiable` is a first-class result alongside pass and fail. A check that
cannot run says so rather than implying success — the same failure as a detector
that never fires, one level up.

| Input | Was | Now |
|---|---|---|
| SVG with no width, height or viewBox | logo-aspect silently skipped | `unverifiable`, with the reason |
| Font filename not matching `family_weight_style` | dropped from the index, no trace | `font-filename-unrecognised`; the file still hydrates |
| Palette value like `Pantone 158C` | entry vanished | `palette-value-not-machine-readable`; colour checks report unverifiable |

Palette conformance now only *fails* a colour when the palette parsed completely.
A brand we cannot compare is not off-brand, and failing every check it has would
be worse than saying we could not tell.

### Degradation ladder

| Curveball | Handling |
|---|---|
| Cache disagrees with `DESIGN.md` | Cache is never hydrated, so no competing value exists |
| `DESIGN.md` contradicts itself | Prose governs and is more specific; ties break on document order so the same brain always resolves the same way, and the resolution is recorded |
| Named font not shipped | Nearest family from that same brain, heaviest weight, recorded |
| Asset path dangles | Preference order within the same kit: `logo_reverse → logo_mark` on a dark ground, `logo → logo_mark` on a light one. If nothing usable is staged, omit and escalate. Never typeset, never borrow |
| Asset tagged to another kit | Quarantine at ingest, filter at hydration, reject at ACK |
| Two assets share a `kind` | Keep both. Never guess which is "the" logo |
| Optional field absent | Never required; fall back within the brain, never invent |
| Unknown section or unit | Passes through untouched |
| Accent unreadable on its ground | Contrast ratio and ground luminance **computed and reported, never enforced** |
| No usable palette at all | Blocked, with a reason |

That last-but-one row is the general line: **compute anything with an exact
answer, leave acceptability to the model.** Software that decides an ad is
off-brand will reject work a person would ship.

## Canvas sizes

Required: 1080x1080, 1200x628, 1080x1350, 728x90. Four sizes means four
separately generated plates, each at exact target dimensions, never cropped or
re-framed.

### gpt-image-2 cannot emit any of the four natively

Per the OpenAI image generation guide, a custom size must satisfy all of:

- both edges multiples of 16px
- long-edge to short-edge ratio no greater than 3:1
- total pixels between 655,360 and 8,294,400
- maximum edge no greater than 3840px

Every required canvas fails the multiple-of-16 rule, so none can be requested
directly. Three are recoverable; one is not.

| Target | Aspect | Generate at | Result |
|---|---|---|---|
| 1080x1080 | 1:1 | 1088x1088 | Uniform downscale x0.992647. Aspect exact. |
| 1080x1350 | 4:5 | 1088x1360 | Uniform downscale x0.992647. Aspect exact. |
| 1200x628 | 300:157 | 3088x1616 | No valid size has this aspect exactly. Closest is 0.0033% off — 0.02px across the full width, which rounds away. |
| 728x90 | 364:45 | **impossible** | 8.09:1 exceeds the 3:1 limit, and 65,520px is below the 655,360 minimum. |

Plates are always generated **above** target and downscaled, never upscaled.
Downscaling preserves detail; upscaling invents it.

The 300:157 case is worth stating precisely: because 157 is prime, an exact
match needs 4800x2512, which breaches the 3840px edge limit. The residual
0.0033% anisotropy is two hundredths of a pixel and is the honest cost of the
constraint. It is recorded rather than hidden.

### The leaderboard is a hard finding

728x90 cannot be produced by gpt-image-2 by any route. Outpainting does not
help, because the 3:1 ceiling constrains the *requested output size*, so no
edit call can return an 8:1 image either. Filling a 728x90 canvas from a
generated plate would require cropping or stretching, both forbidden by
SKILL.md invariant 2.

No other model rescues it either. gpt-image-2's 3:1 is the *most* permissive
ceiling among current models — Nano Banana Pro caps at 21:9 (2.33:1), Flux is
practically the same, and Ideogram and Recraft expose preset ratios only. No
vendor has announced native 8:1 support, because extreme ratios break
composition. Changing model makes this worse, not better.

So 728x90 cannot be produced plate-first by any available means, and the honest
handling is procedural rather than technical:

1. **Detected at intake, not at run time.** Each canvas on a request is checked
   against the image model's capability envelope before a sandbox is created.
   The operator is told which canvas cannot be produced and why, with the
   arithmetic.
2. **The other three are still delivered.** One impossible canvas does not fail
   the request.
3. **Never a silent crop.** Producing 728x90 from a 3:1 generation requires
   cropping into a different aspect ratio, which invariant 2 forbids. That path
   is available only as an explicit, operator-accepted deviation, flagged on the
   request and recorded in `RESULT.json` and DECISIONS.md. It is never the
   default and never happens quietly.

The capability envelope lives in an `image_model_capabilities` row — edge cap,
ratio cap, pixel range, divisor — not in code. When a model with wider support
ships, that is a row change, and a fifth canvas size gets validated by the same
generic arithmetic.

This is the brief's own instruction taken literally: "If your sizing logic can't
produce one of them, that's a finding — say so, rather than letting the request
fail at run time."

### The options, ranked

The brief contradicts itself here — "these sizes have to work" and "if your
sizing logic can't produce one of them, that's a finding" cannot both hold. It
also says to ask when something is ambiguous, so we ask.

| Option | Compliance | Cost |
|---|---|---|
| **A. Email and ask** | The brief invites exactly this: one email resolves it | A reply. Chosen, alongside B as the default meanwhile |
| **B. Escalate as a finding** | Fully compliant, no invariant bent | No leaderboard exists |
| **C. Designed band, then crop** | Crops into a different aspect — invariant 2 | Best-looking of the crop family. Operator-accepted deviation only |
| **D. Geometric plate rendered to exact dimensions** | Arguably compliant: "if the treatment is geometric, the geometry belongs in the plate", and it is one full-canvas raster at exact size | Not made by the image model |
| **E. Stitch several generations** | The industry workaround | Seams at 90px tall; too much machinery for one canvas |
| **F. Non-uniform squash** | Stretching — invariant 2 | 2.7x vertical compression destroys any subject. Rejected |

Option C is worth explaining because it is the one a human art director would
reach for: prompt deliberately for a wide composition with empty margins above
and below, then take the band. It is still a crop by the letter of the rule, but
the discarded region was never intended as content.

Option D deserves more credit than it first appears to. Real leaderboards are
rarely photographic, and Emplifi's own banner in this packet is a navy field with
geometric shapes rather than a photo — so a rendered geometric plate is
brand-authentic for this format specifically, not a fallback.

This compounds with Kahua's own rule: a fixed 48px h1 with "cut the copy, do
not scale the type" cannot coexist with a logo and a CTA inside 90px of height.
Two independent reasons the leaderboard is the canvas that does not work.

Inspirations are 1200x1200, 600x200, 1080x1080, 1200x1280 — no inspiration
matches a target canvas, which reinforces that plates are generated, not
adapted.

Note also that gpt-image-2 does not support transparent backgrounds. This costs
nothing here: plates are full-bleed by definition, and logos are placed from
the brain's own SVG files.

## Sandbox runtime

Inside each E2B sandbox, a Claude Agent SDK process runs the job. The image
model is not called by the model directly; it is wrapped as a custom tool on an
in-process SDK MCP server, registered through `mcpServers` and pre-approved in
`allowedTools` as `mcp__design__*`.

| Tool | Responsibility |
|---|---|
| `generate_plate` | Maps target canvas to a legal gpt-image-2 size, generates, downscales uniformly, **saves and ACKs before returning**, and returns the plate as an image block so the model sees it |
| `render_canvas` | Playwright renders the HTML overlay to PNG at exact canvas bounds |
| `look_at_render` | Returns the rendered PNG as an image block for the mandatory visual judgement |
| `save_artifact` | Thin wrapper over the `save_work` script, so a rejection also arrives as a structured tool result |

The save mechanism is the `save_work` script, documented under Save-out. The tool
is a wrapper over it rather than the other way round.

An attached inspiration is passed into the `generate_plate` call as reference
imagery alongside the brand colours, which is what it is for. It never
contributes a token, a colour sample, or a line of copy.

The split follows the brief's rule about where checks belong. The size
arithmetic has exact answers, so software owns it and the tool refuses an
impossible canvas with the numbers in the error message. Whether the ad is any
good has no exact answer, so the model owns it by looking at the render.
Returning images as content blocks is what makes "look at what you made"
a real step rather than a claim.

Tool handlers return `isError: true` with composed messages rather than raw
exceptions, so a failure arrives as something the agent can read and act on
within the same run.

## Supabase

Two things to provision, both versioned as SQL in the repo. No VPC, no subnets,
no load balancer, no edge — there is nothing to put them in front of.

**Schema.** `brand_kits` · `brand_assets` · `brand_fonts` · `requests` ·
`request_canvases` · `revisions` · `messages` · `runs` · `artifacts` ·
`findings`. Migrations are numbered files applied in order, which is the same
property Terraform state gave us: a reviewer can see how the shape was reached.

**Buckets.** `brains` and `work`, both private. Versioning on `work` so a
superseded attempt's bytes survive without a version graph.

### Row-level security is the isolation

This is the part that replaces IAM, and it is stronger for what is being graded
here. Every table has RLS enabled and **denies by default** — a table with no
policy is unreachable rather than open.

The backend mints a short-lived JWT for each run:

```json
{ "role": "sandbox_run", "run_id": "…", "revision_id": "…", "brand_kit_id": "bk-…" }
```

Policies turn those claims into hard limits:

| Table or bucket | Policy |
|---|---|
| `brand_assets`, `brand_fonts` | `SELECT` only where `kit_id = jwt.brand_kit_id` |
| `artifacts` | `INSERT` only where `revision_id = jwt.revision_id` |
| `runs` | `UPDATE` only its own row |
| `storage.objects` in `work` | read and write only under `<task-id>/rev-<n>/` |
| `storage.objects` in `brains` | `SELECT` only under the run's own kit |
| everything else | no policy, therefore no access |

**The cross-tenant leak is now a database rule.** The mis-tagged
`partner-lockup.svg` is tagged to one kit and sits in another brain's folder; an
Emplifi run carries an Emplifi `brand_kit_id`, so the row is simply not visible to
it. Isolation is enforced where the data lives rather than by a credential
wrapper around it — which makes the leak test a SQL-level assertion, much harder
to fake than a green tick.

### The one key that must never leave the machine

`service_role` **bypasses RLS entirely.** It stays in the backend's `.env` and is
never placed in a sandbox environment, never in a hydration file, never in a log.
Every guarantee on this page rests on that, so it gets its own check rather than a
footnote.

## Keeping the agent off the backend

The backend now runs on a laptop, which makes spawning the agent beside it
*easier*, not harder, and there is no cloud boundary left to lean on. Two guards,
and both are real:

1. **No agent runtime in the backend package.** The Agent SDK is not a dependency
   of the app, and a lint rule bans `child_process` there. CI fails on either, so
   the code that would run an agent locally cannot be merged.
2. **A run row requires a non-null `sandbox_id`**, by database constraint, and an
   artifact belongs to a revision produced by a run. Work generated anywhere but a
   sandbox therefore has **nowhere to record itself** — it cannot become an
   artifact, so it cannot reach the front end or a deploy.

Guard 2 is the wall. It does not ask the backend to behave; it makes
locally-produced work unrepresentable.

### What is *not* a guard

An earlier draft counted key custody as a third guard — the backend holds the
model keys only in order to pass them into a sandbox, so it "could" call the image
API itself. That was guarding the wrong thing.

**Calling an image API is not running an agent.** No disqualifier prohibits it, and
key possession says nothing about where the agent executes. The claim is removed
rather than softened, because a guard that protects against a non-risk is worse
than no guard: it draws attention away from the two that work.

The same reasoning kills it from the other direction. **Gate 0 runs the agent on a
laptop deliberately** — the brief requires the skill to work in your own Claude
Code before anything touches a sandbox. A rule against holding model keys locally
would forbid stage 0. What separates Gate 0 from a violation is not custody but
category: it produces a validated skill file and prompt, and is never a code path
the running system can take.

## How it runs

```bash
cp .env.example .env     # Supabase URL, keys, OpenAI, Anthropic, E2B
npm install
npm run db:push          # apply migrations
npm run dev              # front end + API on localhost
```

No deploy pipeline, because there is nothing to deploy to. CI still runs on every
pull request — typecheck, lint, the full suite, the tenant-name grep — because it
grades the code regardless of where the code runs.

The **sandbox template** is the one thing that still publishes: `e2b template
build` on changes under `sandbox/`, writing the new template id to a config row so
a rebuild needs no code change.

A reviewer clones the repo, fills in `.env`, and runs two commands. That is a
better answer to *"it should run"* than an AWS account they have no access to.

## Brain ingest

A brand has to get into the system before a run can pull it, and on day two an
unseen brain arrives. Ingest is that path: **add a company, or add assets to a
company that already exists.**

Two entry points, one routine. The front end takes an upload — a brain directory
or an archive — and shows the findings report before anything is committed. The
same routine is available as a CLI for loading a brain from disk.

The work is a pure planner, `planIngest(dir)`, which returns the objects to
upload, the rows to write, and what is wrong with the input. It touches no bucket
and no database, so it is testable before either exists and the backend's job
reduces to executing a plan.

### Identity comes from the manifest

The kit id is read from `asset_manifest.json`, never from the folder name, and
every object lands under `<kit_id>/<path within the brain>`. This packet is the
argument: it contains an asset whose folder and whose kit disagree, and trusting
the folder is how a competitor's mark reaches the wrong canvas.

### Foreign assets are quarantined, not dropped

An asset tagged to a kit other than the manifest's own is stored and recorded but
marked unavailable, so it can never be offered to this kit. Storing it preserves
the evidence; withholding it stops the leak.

That makes ingest a **third independent gate**, alongside the hydration filter
and the ACK check. A mis-tagged asset has to get past all three.

### The findings report

Findings are produced once, at ingest, rather than rediscovered by every run.
Each is generic — no rule names a customer.

| Code | Severity | Meaning |
|---|---|---|
| `kit-id-from-manifest` | info | Records where identity came from |
| `folder-name-differs-from-kit` | info | Folder and kit disagree; the manifest governs |
| `withheld-from-runs` | info | Stored for the record, never hydrated — the token cache |
| `asset-missing-file` | review | Listed in the manifest, no file behind it |
| `asset-foreign-kit` | review | Quarantined cross-tenant asset |
| `font-substituted` | review | A declared family resolved to a nearest shipped family |
| `font-unresolvable` | review | Nothing shipped matches; fallback is not the brand |
| `token-cache-conflict` | review | The cache disagrees with `DESIGN.md`, which wins |
| `no-design-doc` / `no-asset-manifest` / `no-kit-id` | blocked | The kit has no brand or no identity |

Only `blocked` stops an ingest. A `review` finding is surfaced to the operator
and recorded against the kit, because these are the conditions a person should
decide about rather than a machine silently absorbing them.

### Adding assets later

Re-ingesting a kit picks up new manifest entries and new files under the same kit
id. Objects are digested on the way in, so an artifact can record which byte
sequence it was built from. No version graph — S3 versioning retains the history
and each artifact records the digest it used, which is traceability without the
time a graph would cost.

## Functional verification

Ten things that would look correct on paper and fail in practice, each paired with
the check that proves it. Five infrastructure checks from the AWS design are gone
with the infrastructure; four RLS checks replace them, and they matter more.

| # | Failure | Check that catches it |
|---|---|---|
| 1 | **Fonts silently fall back.** A TTF in a directory is not used by Chromium unless installed into fontconfig or loaded via `@font-face` with a `file://` src. The render looks fine and the type is wrong. | Post-render assertion: computed `font-family` on every text node matches a family from the brain. **Fails the render.** |
| 2 | **The `service_role` key reaches a sandbox.** It bypasses RLS completely, so every other guarantee on this page evaporates at once. | The launch payload is scanned for it before a box is created, and the sandbox env is asserted to contain only the scoped run JWT. **Refuses to launch.** |
| 3 | **A table ships with RLS off.** Deny-by-default only holds if it is switched on everywhere; one table without it is an open door. | Query `pg_class` for every table in the schema and assert `relrowsecurity`. A new table with no policy fails CI. |
| 4 | **A run writes to another revision.** The claim scoping is only real if the policy actually refuses. | With a run JWT for revision A, attempt an insert and an upload for revision B and assert both are **denied**. Asserting the denial, not the permission. |
| 5 | **A run reads another kit's assets.** This is the cross-tenant leak. | With an Emplifi run JWT, select the mis-tagged asset and assert zero rows. Then relax the policy and watch the same test fail. |
| 6 | **Deploy recording lost.** Playwright flushes video on `context.close()`; a killed box loses it, and no recording means no deploy. | Recording uploaded and its row inserted *before* the run completes. A deploy run without one **cannot reach `completed`**. |
| 7 | **Signed URLs expire mid-run.** A twelve-minute run with five-minute URLs fails on a late fetch. | Expiry exceeds max run duration; the E2B sandbox timeout is set explicitly above it. Proven by a deliberately slow run. |
| 8 | **Soft-deleted objects are never removed.** Marking a row hidden does nothing to the bytes. | A `pg_cron` cleanup removes objects for rows deleted beyond the retention window, verified by running it rather than by trusting it exists. |
| 9 | **A tenant name reaches the source tree.** | CI greps for tenant names outside fixtures and tests and fails the build. |
| 10 | **Input software cannot read passes quietly.** An SVG with no intrinsic size, a font filename we cannot index, a palette in Pantone. | A third outcome. `unverifiable` is reported and surfaced by `unverified()`, so "nothing failed" and "nothing was checked" cannot look alike. |

Checks 1, 2 and 6 carry hard failures rather than warnings. Check 2 is the one to
read twice: RLS is the whole isolation story, and a single leaked key turns all of
it off.

## Roadmap

### Why this order

Five constraints fix the sequence, and every one is a real dependency:

1. **The evaluation layer precedes what it grades.** Already built, which is why
   Gate 0 can be judged rather than eyeballed.
2. **Nothing touches a sandbox until the skill is boring.** The brief makes this a
   gate: skip it and a later failure is indistinguishable between a database
   problem, a skill problem and a hydration problem.
3. **The database and its policies exist before anything writes to them.** RLS is
   the isolation, so it cannot be retrofitted after the write paths are built.
4. **A brand exists before a run can pull one.** Ingest is the precondition for
   every run and the whole of the third-brand test.
5. **Deploy is an automatic disqualifier**, so it gets room in front of it.

### Precondition — the evaluation layer *(done)*

Not a stage, because it grades all of them. **144 tests, no browser, no image
model, no cloud**: the capability envelope, brain loading, the ingest planner, the
render checks, the disqualifier scanners, and every case where input resists being
read. Each detector is shown catching a planted violation, and a third outcome —
`unverifiable` — exists so a check that cannot run never reads as success.

### Everything we are using, and why

| Layer | Choice | Why this one |
|---|---|---|
| Language | TypeScript on Node 22 | One language across front end, API, sandbox tooling and tests |
| Front end + API | Next.js, **run locally** | React is required; Next puts the API in the same process, so one thing to run and nothing to deploy |
| Database | Supabase Postgres | Reachable from both the laptop and the sandbox — which is what makes a local backend workable |
| Isolation | Supabase RLS + a scoped run JWT | Enforced where the data lives, so the cross-tenant leak is a database rule rather than a credential wrapper |
| Queue | The `runs` table | `FOR UPDATE SKIP LOCKED`; a queue service would duplicate what the table and provider liveness already do |
| Object store | Supabase Storage | `brains` and `work`, both private. Key is the relative path, so resume is a sync |
| Live updates | Supabase Realtime | The asset view fills in as artifacts land, with no polling code to write |
| Sandbox | E2B, one per run | The one piece that must be remote, because the brief forbids the agent on your laptop |
| Agent | Claude Agent SDK, in-sandbox | In-process tools plus the hooks durability depends on |
| Image model | gpt-image-2 | Required. Wrapped as a tool so the size arithmetic is deterministic and judgement stays with the model |
| Render + browser | Playwright, in-sandbox | HTML to PNG and the deploy browser are the same dependency, so one template covers both |
| Save-out | `save_work` script in the box | The agent saves its own work; a plain executable is inspectable by hand inside the box |
| Schema | Numbered SQL migrations | Same property Terraform state gave us — a reviewer can see how the shape was reached |
| CI | GitHub Actions | Grades the code regardless of where the code runs |
| Tests | Vitest + pngjs | No native dependencies, no browser for the check library, sub-second runs |

### The architecture, and why each piece is there

Bracketed numbers are the stage that builds that piece.

```
   everything is OUTBOUND — nothing connects in to the local machine

┌───────────────────────────────────────────────────────────────────────────┐
│ [3] YOUR MACHINE · localhost                                              │
│     Next.js — React front end + API together                              │
│     [4] brain ingest   [8] chat surface                                   │
│                                                                           │
│ why  · React is required by the brief; Next puts the API on the           │
│        same process, so one thing to run                                  │
│ fits · NEVER runs an agent. No Agent SDK in the package, a lint           │
│        rule against child_process, and a DB constraint requiring          │
│        a sandbox_id. That is disqualifier 3 — and it matters more         │
│        here, because the agent is now easy to reach.                      │
└───────────────────────────────────────────────────────────────────────────┘
              │                                        │
              │ create box +                           │ read + reconcile
              │ write HYDRATION.md                     │
              ▼                                        ▼
╔═══════════════════════════════════════════════════════════════════════════╗
║ [5] E2B sandbox · ONE PER RUN · the only thing not local                  ║
║     boots holding only an opaque run id + a scoped JWT                    ║
║     Claude Agent SDK  ·  [0] skill, plate, overlay, render                ║
║     [9] Playwright browser + recording                                    ║
║                                                                           ║
║ why  · a plain sandbox provider, not a managed-agent platform.            ║
║        The brief forbids the agent running on your laptop; this           ║
║        is the one piece that must be remote.                              ║
║ fits · the agent cannot live where the backend lives. No box              ║
║        identity names a tenant or a task.                                 ║
╚═══════════════════════════════════════════════════════════════════════════╝
              │
              │ upload artifacts · insert rows · never speaks to the backend
              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ [2] SUPABASE · hosted                                                     │
│     Postgres: runs · revisions · messages · artifacts · brand state       │
│              [7] the runs table IS the queue                              │
│     Storage: brains/<kit-id>/…    work/<task-id>/rev-<n>/…                │
│                                                                           │
│ why  · reachable from both the laptop and the sandbox, which is           │
│        what makes a local backend workable at all. Realtime pushes        │
│        artifacts to the UI with no polling code.                          │
│ fits · RLS is the isolation. A run JWT carries revision_id and            │
│        brand_kit_id; policies make those the only rows and objects        │
│        it can touch. The cross-tenant leak becomes a database rule,       │
│        enforced where the data lives.                                     │
│        Key = relative path, so resume is a sync.                          │
└───────────────────────────────────────────────────────────────────────────┘
              │
              ▼
   third-party APIs, called from the sandbox only
   OpenAI gpt-image-2  ·  Anthropic  ·  Adstream

   ✗ NEVER · the backend reading the box · syncing an out-directory ·
             spawning the agent locally · the service_role key in a
             sandbox env, which would switch RLS off entirely

   [1]  CI automates the checks ..... the eval layer is a precondition
   [6]  sandbox evaluation layer .... what only a live box can prove
   [10] evidence .................... leak · kill · interleave · third brand
```

---

### Stage 0 — Gate 0: ads worth defending *(next)*

Resolve the brand data, build the plate call and the overlay, render to PNG, look
at it. Twenty ads across both brands.

**Stack** TypeScript · gpt-image-2 · Playwright — all local.
**Why** No cloud at all, so it costs the rest nothing. gpt-image-2 is required;
Playwright is the same renderer the sandbox will use, so nothing is thrown away.

---

### Stage 1 — Automate the checks

Actions on pull request: typecheck, lint, the suite, the tenant-name grep, and the
RLS-enabled-everywhere assertion.

**Stack** GitHub Actions.
**Why** Already attached to the repo, and it grades the code wherever the code
runs.

---

### Stage 2 — Supabase: schema, buckets, policies

Numbered migrations for the ten tables, two private buckets, and RLS on
everything with deny-by-default.

**Stack** Supabase Postgres · Supabase Storage · SQL migrations.
**Why** RLS is the isolation, so it has to exist before anything writes. Hosted
rather than local, because the sandbox has to reach it and a local Supabase has
the same unreachability problem a local API does.

---

### Stage 3 — The application, locally

The Next.js shell, the operator views, and the intake path. Nothing to deploy.

**Stack** Next.js · `next dev` · Supabase client · Realtime.
**Why** Realtime means the asset view updates as artifacts land without a polling
loop. Running locally removes the edge, the load balancer, the compute layer and
the deploy pipeline outright — none of which earned points.

#### The front end, stage by stage

| Stage | What lands in the UI |
|---|---|
| **3** | The shell: layout, routing, customer switcher, run list, empty asset view |
| **4** | Brain ingest: upload, and the findings report shown *before* anything commits |
| **5** | The asset view fills in over Realtime, at whatever count the run produced |
| **7** | Run state: partial saves labelled *"saved early"*, delete, re-run |
| **8** | Chat against a named revision |
| **9** | Deploy, the recording link, the verified detail page |

---

### Stage 4 — Brain ingest

Upload a brain, store every object at `brains/<kit-id>/<path>`, write the kit,
asset and font rows, show the findings report before committing.

**Stack** `planIngest` (already built) · Supabase Storage · Postgres.
**Why** A pure planner needed no bucket and no database to test, so the logic was
verifiable before either existed.

---

### Stage 5 — One real sandbox run, end to end

Hydrate a box, pull the brain fresh, generate, save, kill it.

**Stack** E2B · Claude Agent SDK · `save_work` · scoped run JWT.
**Why** E2B is a plain provider rather than a managed-agent platform. The JWT
carries `revision_id` and `brand_kit_id`, and RLS turns those claims into the only
rows and objects the run can touch — no endpoint of ours in the path.

---

### Stage 6 — Sandbox evaluation layer

Tests for what only a live box can prove: hydration fidelity digest for digest,
cross-revision writes **denied**, cross-kit asset reads returning zero rows,
key-equals-relative-path, font provenance in a real render, durability across a
mid-run kill, and the `service_role` key absent from every launch payload.

**Stack** Vitest · E2B SDK · Supabase client with a run JWT.
**Why** The same runner as the local layer, so one command covers both. And a run
JWT makes the isolation tests plain SQL — far harder to fake than a green tick.

---

### Stage 7 — The engine

Concurrency to the cap, resume, retry, partial saves, soft delete, re-run.

**Stack** Postgres `FOR UPDATE SKIP LOCKED` · E2B lifecycle API · `pg_cron`.
**Why** The runs table is already the queue, so the cap is a `count(*)`. Asking
E2B whether a sandbox exists is authoritative where a heartbeat only proves the box
was alive some seconds ago. `pg_cron` removes soft-deleted objects, since Storage
has no lifecycle rules.

---

### Stage 8 — Chat surface

A message against a named revision reaches the agent, and the updated asset
returns.

**Stack** Next.js · Postgres · Realtime.
**Why** Chat rather than pins because the graded part is whether the message
hydrates to the right tenant, task and revision — identical either way — and the
hours saved go to deploy.

---

### Stage 9 — Deploy *(automatic disqualifier if unfinished)*

A deploy is its own run, so it spins **its own fresh box** — the generation box
died when that run ended. This one hydrates the finished artifacts from
`work/<task-id>/rev-<n>/` rather than a brain, drives Adstream, saves the
recording, and reads the detail page back.

**Stack** Playwright in the sandbox, agent-driven.
**Why** The browser has to run where the agent runs, or the paradigm breaks. And
Playwright is already in the template for rendering, so deploy adds no new
dependency — only the credentials, the allowed tools and the prompt differ. The
agent decides from each screenshot rather than following a selector script, because
the graded test is resilience to a UI change.

---

### Stage 10 — Evidence

Plant a leak and catch it, then relax the RLS policy and watch the same check fail.
Kill a box and resume. Run the interleaved concurrent case. Take a third brain
through untouched.

**Stack** The suites from stages 1 and 6.
**Why** Nothing new to build — both harnesses already exist, which is the point of
having built them first.

## The engine

A first generation is never the final asset. Every regeneration, every edit the
next day, every concurrent run by the other customer is the same event.

### Concurrency and isolation

Many sandboxes run at once. Two customers can be mid-edit simultaneously and
neither waits for the other. The unit of isolation is **the run, not the
tenant.**

This matters, and the distinction is the difference between passing and being
disqualified. A per-tenant box — "the Emplifi box" — is a named disqualifier,
and it is also weaker: the horrifying test case has Emplifi running two tasks at
the same time, and under per-tenant boxes those two share one box and can cross.

| | Per-tenant boxes | Per-run boxes |
|---|---|---|
| Two customers at once | Yes | Yes |
| Two runs from one customer at once | Share a box, can cross | Isolated |
| Box identity | Names the tenant, disqualified | Opaque run id |
| A new brand | Needs a new box definition | Works untouched |

Nothing about a sandbox — name, template, tags, environment — records which
tenant or task it serves.

The queue is the `runs` table, not a queue service. A dispatcher claims work
with `SELECT ... WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED`,
limited by the named cap minus the current `running` count. "The fourth request
waits" is a row staying `queued`. No scheduler.

A dedicated queue service was considered and rejected: its three jobs here — cap
enforcement, durability of pending work, and reclaiming stalled runs — are all
things the run table and provider liveness already do, and running both would mean
two sources of truth about whether a run is pending.

### Run states, partial saves, and deletion

```
queued → running → { completed | partial | interrupted | failed }
```

`partial` is the deliberate case: the operator hit **Save & exit** and the agent
flushed what it had. The UI says so plainly — *"Saved early — 2 of 4 canvases"* —
with an amber state chip, never a green one, because a half-finished asset that
looks finished is the failure mode this whole design is arguing against.
`interrupted` looks the same to the operator but was not their choice.

`Save & exit` is available both while a run is working and after the agent
reports done. Mid-run it banks what exists rather than discarding it.

**Deletion is soft.** A `deleted_at` timestamp hides the run and its artifacts
from the UI, and **tags its objects `deleted=true`** so a single static lifecycle
rule expires them later. Tagging rather than a per-run rule because lifecycle
configuration is static — there is no way to add a rule per deleted run, so a
prefix-based plan would quietly never delete anything. Soft rather than hard
for two reasons: revision four may have been built from revision three's plate,
so a hard delete would orphan a child, and a mis-click should be recoverable.

**Retry and re-run are different, and deletion is what separates them.** An
automatic retry after a crash reuses verified artifacts, because the image call
was already billed. An operator re-running because they disliked the output
should get fresh work — and since a deleted run's artifacts are excluded from
`resume.already_durable[]`, the new run regenerates from scratch. One mechanism,
two behaviours, no flag to get wrong.

### Graceful exit

A run ends by the agent's own action, never by the backend reaching into the
box.

1. The agent finishes and ACKs every artifact.
2. The agent calls `finish_run`, its final tool call, moving run state to
   `completed`.
3. The backend observes the state change and kills the sandbox.

The front end also offers an explicit **Save & exit**. It sends a wrap-up
message into the agent's live session rather than instructing the backend to
collect anything: the agent flushes outstanding work, ACKs it, and calls
`finish_run` itself. The `Stop` hook already refuses to let the agent finish
while an artifact is unsaved.

If the agent does not respond within a deadline, the backend kills the sandbox
anyway and marks the run `interrupted`. That is safe because every ACKed
artifact is already durable, and it never involves reading the box.

Killing a sandbox is not moving work out of it. Reading its filesystem is. No
button, timeout, or teardown path does the second thing.

Resume: kill the box, spin a new one, rehydrate from Storage and Postgres, and the agent
picks up as though the files were never deleted. It should never know.

When a run dies mid-flight: the image model call may already have succeeded and
been billed while the save got halfway. Recovery is per-artifact — anything
whose object landed and verified is reused; anything unverified is regenerated.
Which states a retry recovers and which need a human is documented, having been
found by crashing a run on purpose.

Every run saves its own agent transcript alongside the work.

## Feedback surface

**Chat.** The operator says what is wrong in words, against a named revision.
Pins were the other option and the brief asks for both to be argued: pins are
better for "this specific thing, right here" and carry coordinates a plate
regeneration can use; chat is better for iterative intent and costs a fraction
of the build. Chat is chosen because the graded part is whether the message
hydrates to the right tenant, task, and revision — which is identical either
way — and because the hours saved go to deployment, which is an automatic
disqualifier if unfinished.

A message carries tenant, task, revision, and body. Coordinates are the only
thing lost, and the agent can read the render to find what the operator means.

What matters is that the message hydrates: right tenant, right task, right
revision, and a prompt that conveys what the human meant. Whether an edit is a
text change or a full plate regeneration is the model's call — no classifier gets
built for it.

Done when a message left in the front end round-trips: it reaches the agent
attached to the correct revision of the correct task of the correct tenant, the
agent acts on it, and the updated asset returns to the front end with no manual
step in between.

## Deploy

The same *shape* of event as everything else — a clean box, the right files in, a
prompt — plus a browser, credentials, and a different instruction. Not the same
box: that one is long dead. A deploy is its own run and gets its own.

**One template, separate instance.** Playwright is already in the image for
HTML-to-PNG rendering, so a deploy needs no second template; building one would
duplicate the browser and double what has to be patched. Every deploy is still
its own run in its own fresh box.

Only four things differ between a generation run and a deploy run, all of them
driven by the hydration file rather than by a different subsystem:

| | Generation | Deploy |
|---|---|---|
| `run.kind` | `generate` / `edit` | `deploy` |
| Credentials | Image model key | Adstream login |
| Tools allowed | `generate_plate`, `render_canvas` | browser drive, recording upload |
| Reads | Brain and request | The finished artifacts |

Least privilege follows from that split: a deploy box never holds an image-model
key, and a generation box never holds marketing-tool credentials.

The browser runs in the sandbox, never locally. Adstream
(`https://adstream.bhairav.workers.dev/`) is a client-rendered SPA, so HTTP
calls are not an option.

**The agent drives the browser; a script does not.** A pre-written Playwright
selector script is a named road bump, because the graded test case is whether
the deploy survives a UI change. Playwright is the actuator — click, type,
navigate, screenshot — and the agent is the driver, reading a screenshot after
each step and deciding the next action from what it sees. No selector path is
hardcoded to Adstream's current DOM.

This is also the only way the listed Adstream behaviours can be handled
honestly: a normalised ad name has to be *read back*, a disabled Next button has
to be *observed* rather than waited on blindly, and a toast that outlives its
page cannot be trusted as evidence of anything.

Adstream's real-world behaviours to handle: ad names are normalised on save, so
what was typed is not what is stored; Next and Publish stay disabled until a
page's fields are complete; publishing takes two to nine seconds; duplicate
names are permitted; the success toast lasts six seconds and does not clear on
navigation, so it can appear on a page it does not belong to. The toast is
therefore never treated as evidence.

Every deploy run records the browser session to S3. No recording, no deploy.

After the agent reports success, the ad detail page is the only place the truth
lives. The run is not over until that page has been read and the result saved
with the rest of the work.

## Verification

Software keeps only the checks with exact answers: canvas dimensions, plate
scale uniformity, required strings present and in bounds, logo aspect ratio
within rounding tolerance, asset references resolving inside the project, fonts
sourced from the brain, `brand_kit_id` matching on every placed asset.

No software grades brand conformance. The model reads the rendered PNG and
judges it, because that is the artifact the customer sees. A check that reads
the HTML has verified a file nobody looks at, and the two drift apart without
either looking wrong.

## Evidence

A green check is not evidence. Three demonstrations:

1. **The leak test.** `partner-lockup.svg` is a live Kahua asset inside
   Emplifi's brain. The resolver rejects it on `brand_kit_id`; then the filter
   is deliberately weakened to show the same check failing. A detector that has
   never fired proves nothing.
2. **The kill test.** A box is killed mid-run; a new one rehydrates and the
   agent continues without noticing.
3. **Third brand.** The day-two brain goes through new-task-then-edit with zero
   code changes.

Plus the interleaved concurrent case — Emplifi new, Kahua new, Kahua edit,
Emplifi edit, Emplifi second — with different inspirations in flight, and
evidence that nothing crossed.

## Routed to DECISIONS.md, not built

- What happens when the brand changes between revision three and revision six.
- Stale, resolved, or orphaned pins when the asset regenerates and the thing
  under the pin moved. The brief asks this regardless of which surface is built,
  and we chose chat — so the honest answer is that pins do not exist here, plus
  what we would do if they did.
- The concurrency cap, and what happens to the fourth request.
- The blast radius of the agent's credentials.
- The Kahua 728x90 impossibility.
- Barlow Condensed named but not shipped.
- The missing `kahua-logo-white.svg`.

## What gets submitted

Treated as part of the deliverable, not paperwork.

- **Every agent transcript, raw and untidied.** Missing transcripts are the
  single most automatic disqualifier — code without them cannot be graded. That
  includes the sessions that produced this spec, dead ends included. They are
  committed as captured; the mess is the point.
- The repo with full git history.
- Everything the system produced: ads for all three brands, plates, bucket
  contents, a database dump, deploy recordings.
- `DECISIONS.md`, carrying the four routed questions plus what was stubbed and
  which claims are least certain.

All four parts must be finished. An otherwise strong submission that does not
reach deployment is the second most common automatic disqualifier, which makes
deploy a scheduling constraint rather than a final flourish.

## Explicitly not built

Brand-kit version graphs and rollback. Optimisation of any kind, including cold
starts. Separating compute from the coding agent. A classifier deciding edit
type. Software that grades brand conformance.
