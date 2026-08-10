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

| Layer | Choice |
|---|---|
| Front end | React, served from EC2 |
| Backend API | Same EC2 box, private subnets |
| Edge | CloudFront → VPC origin → internal ALB → EC2 |
| Database | RDS Postgres, isolated subnets |
| Object store | S3 — brains, run outputs, Terraform state |
| Sandboxes | E2B, one per run, off-AWS |
| Agent runtime | Claude Agent SDK inside the sandbox |
| Image model | gpt-image-2, wrapped as an SDK custom tool |
| Queue | SQS job queue + DLQ |
| Secrets | Secrets Manager, agent gets scoped STS sessions |
| IaC | Terraform, S3 backend with `use_lockfile = true` |

Front end and backend are deliberately co-located on EC2. Sandboxes are
deliberately not — that separation is what keeps constraint 3 satisfied by
construction rather than by discipline.

Sandboxes living outside the VPC is an accepted trade. "Everything in the VPC"
applies to the control plane: API, RDS, ALB, and CloudFront's path to them are
private. Agent boxes reach S3 over the public endpoint using short-lived scoped
credentials. The S3 gateway endpoint therefore serves the backend, not the
agent.

## Hydration

Three kinds of data go into a box. They look alike and are not.

| Lifetime | Contents | Path in |
|---|---|---|
| Same every run | SKILL.md, contracts, renderer, Playwright, fonts runtime, save-out CLI | Baked into the E2B template |
| Same per customer | The brain: `DESIGN.md`, `fonts/`, asset manifest, logos | Pulled fresh from S3 every run, never baked |
| One job | Request, copy, comments, revision lineage | Job manifest fetched from S3 at boot |

The brain is never baked. That is what makes a rebrand not need a rebuild.

**The box boots holding only an opaque run id.** No tenant in its name, tags,
or metadata. It learns which brand it serves by fetching the job manifest, then
pulls that brand's kit. A box that already knows its tenant is the failure this
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

The rendered file is persisted to S3 as the run's replayable recipe, which makes
resume a replay rather than a reconstruction.

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
comments:
  - {id: cm_01, canvas: portrait, region: {x: 78, y: 640, width: 604, height: 214}, body: "..."}
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

- The backend mints an STS session scoped to `s3://cq-work/<run-id>/*` via a
  session policy with a short TTL, passed into the sandbox as environment.
  Blast radius is exactly one prefix.
- The agent writes plates, rendered PNGs, HTML projects, its own transcript,
  browser recordings, and `RESULT.json`.
- After writing, the agent re-reads each object and compares size and digest
  against what it wrote. A mismatch fails loudly, in words, in the same run,
  while the agent can still fix it.
- `RESULT.json` is written last and is the commit marker. An S3 event to SQS
  wakes the backend to reconcile S3 into RDS.

The backend reads S3. It never reads the box. Saving work is not publishing,
and reading durable storage is not reaching into a sandbox.

There is no terminal manifest. Completion is a state transition in RDS driven
by the last ACK, so no single file can strand a run's output.

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
5. **Heartbeat.** If it stops, the backend marks the run `interrupted`.
   Everything already ACKed is reused on retry; anything unverified is
   regenerated.

E2B's own `lifecycle.onTimeout: "pause"` is configured as a soft landing, so a
timeout preserves filesystem and memory instead of destroying them, and resume
costs about a second. It is deliberately **not** the durability mechanism: it
covers timeout but not `kill()` or infrastructure failure, and there is a
reported issue where filesystem changes stop persisting after the second
resume. Pause/resume is treated as a speed optimisation for the resume path,
never as the thing that keeps work safe.

## Brand data resolution

The brand data is not internally consistent. Per the brief, these are found and
recorded, not adjudicated by machinery. One value picked, everything set to it,
written down.

### The cross-tenant leak, pre-planted

`emplifi/brand/asset_manifest.json` lists `partner-lockup.svg` tagged
`brand_kit_id: "bk-kahua-2026"`. That file is the Kahua logo — orange hexagon,
`aria-label="kahua"` — sitting inside Emplifi's brain folder. Resolving assets
by folder or by `kind` ships Kahua's mark on an Emplifi ad, silently. Filtering
on `brand_kit_id` is the fix, and this asset is the live fixture for proving
the filter works.

### Kahua

| Conflict | Resolution |
|---|---|
| Type scale says h1 56px; the *Applying it* prose says 48px on every canvas; `tokens.json` says 56px | 48px. The prose is as binding as the numbers, and it is the more specific statement. |
| Heading font is Barlow Condensed; `fonts/` ships only Barlow 400/500/600/700 | Barlow 700, tightly tracked. Recorded as a substitution. Browser fallback is not the brand, so nothing is left to chance. |
| Manifest lists `brand/kahua-logo-white.svg`; the file does not exist | Omit the reverse logo, or place the standard logo where the ground permits. Never typeset a substitute. |
| The Kahua inspiration uses a red CTA (~`#E4002B`) and a Hensel Phelps co-brand lockup | Ignored. Accent `#F26B21` carries the CTA; no hue outside the palette. |

### Emplifi

`tokens.json` disagrees with `DESIGN.md` on secondary (`#5B5BD6` vs `#6765FE`),
radius (`16px` vs `12px`), and h1 (`56px` vs `48px`). `DESIGN.md` wins on all
three. The trap is that the token cache was exported later (2026-07-28) than
`DESIGN.md` was reviewed (2026-04-02), so freshness argues for the file that
has no authority.

The Emplifi inspiration shows a solid orange filled pill CTA. `DESIGN.md` says
orange is never a fill and a CTA is an orange label inside a 2px orange
outline on the navy ground. `DESIGN.md` wins.

The Emplifi logo contains `#37B6E9`, which is not in the palette. It is a
placed asset, so it ships as-is; the colour is never promoted to a token.

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
| `save_artifact` | Uploads, verifies, ACKs, and returns any rejection as text the model can act on |

The split follows the brief's rule about where checks belong. The size
arithmetic has exact answers, so software owns it and the tool refuses an
impossible canvas with the numbers in the error message. Whether the ad is any
good has no exact answer, so the model owns it by looking at the render.
Returning images as content blocks is what makes "look at what you made"
a real step rather than a claim.

Tool handlers return `isError: true` with composed messages rather than raw
exceptions, so a failure arrives as something the agent can read and act on
within the same run.

## Terraform

One apply, full stack.

Networking: VPC across two AZs; public subnets for NAT; private app subnets;
isolated DB subnets; IGW; NAT gateway; route tables. S3 gateway endpoint;
interface endpoints for Secrets Manager, STS, CloudWatch Logs.

Compute and data: EC2 in private subnets behind an internal ALB; RDS Postgres
in isolated subnets with credentials in Secrets Manager; SQS queue and DLQ.

Edge: CloudFront with a VPC origin to the internal ALB. Nothing publicly
exposed.

Buckets: `cq-brains`, `cq-work` (versioned), and a bootstrapped `cq-tfstate`
with `use_lockfile = true`. State locking is native S3; no DynamoDB table.

IAM: EC2 instance role, the assumable per-run agent role, Terraform execution
role.

## Sequencing

**Gate 0 first, regardless of infra scope.** The skill must generate ads worth
defending locally, both brands, all four sizes, before anything touches a
sandbox. It needs no AWS, so it costs the Terraform work nothing. Target is
twenty ads with the brand conflicts resolved and recorded.

Then: Terraform apply → one real run end to end through the hydration path →
the engine (concurrency, resume, kill and retry) → feedback surface → deploy
agent with recording.

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
tenant or task it serves. Concurrency comes from SQS plus a named cap on
simultaneous sandboxes: more boxes horizontally, and the request past the cap
waits. No scheduler.

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

Resume: kill the box, spin a new one, rehydrate from S3 and RDS, and the agent
picks up as though the files were never deleted. It should never know.

When a run dies mid-flight: the image model call may already have succeeded and
been billed while the save got halfway. Recovery is per-artifact — anything
whose object landed and verified is reused; anything unverified is regenerated.
Which states a retry recovers and which need a human is documented, having been
found by crashing a run on purpose.

Every run saves its own agent transcript alongside the work.

## Feedback surface

Pinned comments on regions, not points. A pin carries tenant, task, revision,
canvas, and coordinates.

What matters is that the comment hydrates: right tenant, right task, right
revision, right coordinates, and a prompt that conveys what the human meant.
Whether an edit is a text change or a full plate regeneration is the model's
call — no classifier gets built for it.

Done when a comment left in the front end round-trips: it reaches the agent
attached to the correct revision of the correct task of the correct tenant, the
agent acts on it, and the updated asset returns to the front end with no manual
step in between.

## Deploy

The same event as everything else — same box shape, same files — plus a
browser, credentials, and a different instruction.

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

The browser runs in the sandbox, never locally. Playwright drives Adstream
(`https://adstream.bhairav.workers.dev/`), which is a client-rendered SPA, so
HTTP calls are not an option.

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
  under the pin moved.
- The concurrency cap, and what happens to the fourth request.
- The blast radius of the agent's credentials.
- The Kahua 728x90 impossibility.
- Barlow Condensed named but not shipped.
- The missing `kahua-logo-white.svg`.

## Explicitly not built

Brand-kit version graphs and rollback. Optimisation of any kind, including cold
starts. Separating compute from the coding agent. A classifier deciding edit
type. Software that grades brand conformance.
