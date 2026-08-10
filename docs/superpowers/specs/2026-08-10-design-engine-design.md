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
| Queue | Postgres, `FOR UPDATE SKIP LOCKED` |
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

The rendered file is persisted to S3 at
`s3://cq-work/<run-id>/HYDRATION.md`, byte-identical to what was written into
the box, as the run's replayable recipe. That is what makes resume a replay
rather than a reconstruction, and it is also the audit record of exactly what a
run was told.

### Exactly what lands in the box

The hydration file names references. These are the files that actually arrive,
and nothing else does:

| Source | Files | How |
|---|---|---|
| Baked in the template | `SKILL.md`, prompt preamble, renderer, Playwright + browsers, `save_artifact` CLI, Agent SDK | Built into the E2B image |
| Fetched per run | `brain/DESIGN.md` | Presigned, digest-checked |
| Fetched per run | `brain/brand/asset_manifest.json` | Presigned, digest-checked |
| Fetched per run | `brain/brand/*.svg` — **only** assets whose `kit_id` equals the run's kit | Filtered at render time |
| Fetched per run | `brain/fonts/*` — the whole directory for that kit | No filtering, no parsing |
| Fetched per run | `inspirations/*` — **only** filenames the request names | Empty list means none |
| Fetched per run (edits) | Parent plate and parent HTML for the canvases being edited | From the parent revision's artifacts |
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
| Operator sends a chat message | New run, new file, comments block populated |
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
- Each ACK is the commit point for that artifact. There is no terminal file and
  no separate reconciliation queue: the row exists because the agent said so and
  the backend verified it.

The backend reads S3. It never reads the box. Saving work is not publishing,
and reading durable storage is not reaching into a sandbox.

There is no terminal manifest. Completion is a state transition in RDS driven
by the last ACK, so no single file can strand a run's output.

### How the sandbox reaches the API

The sandbox is off-AWS and the ALB is internal, so it has no private route in.
The ACK travels the same public path a browser does:

```
sandbox → CloudFront (public) → VPC origin → internal ALB → EC2
```

The ALB is not called by the sandbox; it is the last hop inside the VPC, and
CloudFront is the only public door. Authentication is a per-run bearer token
minted at hydration and scoped to that run, so a token can only ACK artifacts
for the run it was issued to. `/api/*` is configured with caching disabled and
POST and PUT allowed.

Writes to S3 do not take this path — those go direct to the S3 endpoint with the
scoped STS session, which is why the bucket policy has to permit the public
endpoint rather than requiring the VPC gateway endpoint. The gateway endpoint
serves the backend's own S3 access.

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
| Heading font is Barlow Condensed; `fonts/` ships only Barlow 400/500/600/700 | Barlow 700, tightly tracked — the output of the generic nearest-family fallback, not a rule about Barlow. Recorded as a substitution. |
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
| `save_artifact` | Uploads, verifies, ACKs, and returns any rejection as text the model can act on |

`save_artifact` is also baked into the image as a plain CLI the agent can invoke
from Bash with arguments. Same code path, two front doors: the tool gives
structured errors the model reads, and the script keeps the save mechanism
inspectable by hand inside the box, which is how it gets debugged.

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

## Terraform

One apply, full stack.

Networking: VPC across two AZs; public subnets for NAT; private app subnets;
isolated DB subnets; IGW; NAT gateway; route tables. S3 gateway endpoint;
interface endpoints for Secrets Manager, STS, CloudWatch Logs, and — required for
the deploy pipeline — `ssm`, `ssmmessages`, and `ec2messages`. The instance
profile carries `AmazonSSMManagedInstanceCore`; without it Run Command has no
targets and the pipeline fails with nothing to point at.

Compute and data: EC2 in private subnets behind an internal ALB; RDS Postgres
in isolated subnets with credentials in Secrets Manager. No separate queue
service — the run table is the queue.

Edge: CloudFront with a VPC origin to the internal ALB. Nothing publicly
exposed.

Buckets: `cq-brains`, `cq-work` (versioned), and a bootstrapped `cq-tfstate`
with `use_lockfile = true`. State locking is native S3; no DynamoDB table.

IAM: EC2 instance role, the assumable per-run agent role, Terraform execution
role.

## Keeping the agent off the backend

Three guards, in descending order of how much they actually enforce:

1. **No agent runtime on EC2.** The Agent SDK is not installed on the instance
   and the API package has no dependency that executes one. A lint rule bans
   `child_process` in that package.
2. **A run row requires a non-null sandbox id**, enforced by a database
   constraint. A run with no sandbox cannot reach `succeeded`, so a locally
   executed generation has nowhere to record itself.
3. **Least privilege on model keys.** The instance role is denied
   `GetSecretValue` on the model-key secrets; the agent's run role holds that
   permission and the backend brokers a short-lived session into the sandbox.

An earlier draft claimed this made local generation *physically impossible*. It
does not, and the correction matters: the backend mints the run role's session
and therefore briefly holds credentials that can read those secrets. What guard
three actually buys is least privilege and a CloudTrail record of every
`AssumeRole`. Guards one and two are the ones doing enforcement work. Stating
this accurately is cheaper than having it found.

## Delivery pipeline

Two pipelines, both GitHub Actions, both authenticating by **OIDC** — no
long-lived AWS keys ever live in GitHub.

**On pull request:** typecheck, lint, unit tests, and a grep of the source tree
for tenant names that fails the build on a hit outside fixtures and tests.

**App deploy**, on merge to `main`: build a container image tagged with the git
SHA, push to ECR, then **SSM Run Command** tells the instance to pull and
restart. SSM rather than SSH because EC2 sits in a private subnet with no public
IP, so there is nothing to SSH to — SSM reaches it through the interface
endpoints with no inbound rule at all. Rollback is the same command with an
earlier SHA, since image tags are immutable.

**Sandbox template**, on changes under `sandbox/`: `e2b template build` and
publish, writing the new template id to Parameter Store. Runs pick it up without
a code change or a redeploy.

The internal ALB stays. CloudFront VPC origins can target an EC2 instance
directly, which would remove a resource, but the ALB provides a health check
that nothing else does — during an in-place restart it returns a 503 rather than
a refused connection — and it decouples CloudFront from the instance's
lifecycle. Unlike the queue, it is not duplicating something another component
already handles.

Observability stays thin on purpose: one CloudWatch log group, a `/health`
endpoint for the target group, run transcripts in S3, and run state visible in
the UI.

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

Ten things that would look correct on paper and fail in practice. Each is paired
with the check that proves it, because a claim without a check is a hope.

| # | Failure | Check that catches it |
|---|---|---|
| 1 | **Fonts silently fall back.** A TTF in a directory is not used by Chromium unless installed into fontconfig or referenced by `@font-face` with a `file://` src. The render looks fine and the type is wrong. | Post-render assertion: computed `font-family` on every text node matches a family loaded from the brain. Fails the render, not a log line. |
| 2 | **Soft-deleted bytes never expire.** Lifecycle configuration is static, so a per-run prefix rule cannot exist. | Objects tagged `deleted=true`; one static rule targets the tag. Verified by reading the bucket's lifecycle config, not by assuming. |
| 3 | **Deploy pipeline has no targets.** SSM needs `ssm`, `ssmmessages`, `ec2messages` plus `AmazonSSMManagedInstanceCore`. | `aws ssm describe-instance-information` returns the instance before the pipeline is trusted. |
| 4 | **Deploy recording lost.** Playwright flushes video on `context.close()`; a box killed mid-deploy loses it, and no recording means no deploy. | Context closed and the recording ACKed as an artifact *before* `finish_run`. A deploy run with no recording artifact cannot reach `completed`. |
| 5 | **`/api/*` rejects the ACK.** Several managed cache policies block POST. | Its own cache behaviour: caching disabled, POST and PUT allowed. Proven by an ACK from outside the VPC, not from a local test. |
| 6 | **CloudFront 502s at the ALB.** VPC origins connect through AWS-managed ENIs that the ALB security group must admit. | A request through the distribution reaching the app, before anything else is built on top. |
| 7 | **Presigned URLs expire mid-run.** A twelve-minute run with five-minute URLs fails on a late fetch. | Expiry exceeds max run duration; the E2B sandbox timeout is set explicitly above expected duration. Verified by a deliberately slow run. |
| 8 | **State locking silently absent.** `use_lockfile` no-ops on Terraform below 1.11. | Version pinned in `required_version`; two concurrent plans must produce a lock error. |
| 9 | **Any repo can assume the deploy role.** An unscoped OIDC trust policy. | `sub` restricted to this repository and ref, asserted by reading the trust policy. |
| 10 | **A tenant name reaches the source tree.** | CI greps for tenant names outside fixtures and tests and fails the build. |

Checks 1 and 4 are the two that would otherwise pass review and fail a
demonstration, which is why they carry hard failures rather than warnings.

## Roadmap

Ordered. Each step has something that proves it before the next begins.

**Stage 0 — Gate 0, no infrastructure.** Nothing touches a sandbox until this
passes; the brief makes it a gate and it needs no AWS, so it costs the
infrastructure work nothing.

1. Resolve and record every brand conflict — the h1 value, the font
   substitution, the missing reverse logo, the token-cache disagreements.
2. Build the plate call: target canvas to legal gpt-image-2 size, generate,
   uniform downscale, exact-dimension output.
3. Build the overlay: fixed canvas root, positioned text, logo at natural
   proportions, `data-cq-role` attributes.
4. Render to PNG and **look at it** — headline legible across the room, copy on
   quiet ground, logo surviving its background, CTA obviously clickable.
5. Twenty ads across both brands and every producible size. Email a few.

**Stage 1 — CI foundation.** GitHub Actions on pull request: typecheck, lint,
unit tests, and the tenant-name grep. Roughly half an hour, and it pays back
from here on.

**Stage 2 — Terraform bootstrap, by hand, once.** State bucket with versioning
and `use_lockfile`; GitHub OIDC provider and a deploy role scoped to this repo
and ref. Breaks the chicken-and-egg exactly once.

**Stage 3 — Terraform full stack, one apply.** VPC across two AZs, public
subnets for NAT, private app subnets, isolated database subnets, NAT gateway,
S3 gateway endpoint, interface endpoints including the three SSM ones, RDS,
buckets, internal ALB, EC2 with the SSM instance profile, CloudFront with a VPC
origin and two cache behaviours, Secrets Manager, IAM roles. Proven by check 6.

**Stage 4 — Delivery pipelines.** App: build, tag with the git SHA, push to ECR,
SSM Run Command to pull and restart. Template: `e2b template build` on
`sandbox/` changes, id to Parameter Store. Proven by check 3.

**Stage 5 — Brain ingest.** Upload a brain from the front end or the CLI, store
every object under its kit prefix, write the kit, asset and font rows, and show
the findings report. Nothing downstream can run without a brand in the database,
and the third-brand test is this path plus a task. Proven by ingesting a brain
that does not exist in the packet.

**Stage 6 — One real run, end to end.** Render a hydration file from rows, write
it into a box, pull a brain fresh, generate, save through the ACK path, kill the
box. Proven by checks 1, 5 and 7.

**Stage 7 — The engine.** Concurrency to the named cap, resume after a kill,
retry after a crash, partial saves, soft delete, re-run.

**Stage 8 — Chat surface.** A message reaching the agent attached to the right
tenant, task and revision, and the updated asset returning with no manual step.

**Stage 9 — Deploy.** Agent-driven computer use against Adstream, recording
saved, detail page read back as the only source of truth. Proven by check 4.
This is an automatic disqualifier if unfinished, so it is a deadline rather than
a finish.

**Stage 10 — Evidence.** Plant a leak and catch it, kill a box and resume, run
the interleaved concurrent case with different inspirations, take a third brain
through unchanged.

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

SQS was removed deliberately: its three jobs here — cap enforcement, durability
of pending work, and reclaiming stalled runs — are all things the run table and
the heartbeat already do, and running both meant two sources of truth about
whether a run was pending.

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

Resume: kill the box, spin a new one, rehydrate from S3 and RDS, and the agent
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
  under the pin moved.
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
