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

Inspirations are 1200x1200, 600x200, 1080x1080, 1200x1280 — no inspiration
matches a target canvas, which reinforces that plates are generated, not
adapted.

**728x90 for Kahua is a finding, not a bug.** A fixed 48px h1 with "cut the
copy, do not scale the type" cannot coexist with a logo and a CTA inside 90px
of height. This is reported up front rather than failing at run time.

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

Concurrency: SQS plus a named cap on simultaneous sandboxes. More boxes
horizontally; the request past the cap waits. No scheduler.

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
