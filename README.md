# Design engine

An agent that takes a customer's brand, generates a designed ad, lets a human iterate on
it, and pushes it into the customer's marketing tool.

The governing idea, from the brief: **everything is a file system — files and skills,
hydrated in different orders at different times.** Every event here is the same event. A
clean box spins up, the right files go in, an agent gets a prompt, the agent works, **the
agent saves its own work**, the box dies.

Three tiers of file, separated by how long each lives. What is the same every run — the
skill, the toolkit, `save_work` — is baked into the image. What is the same for one
customer — the brand — is pulled fresh from storage on every launch, so no box ever knows
which brand it serves and a rebrand needs no rebuild. What lives for one job — the
request, its copy, its comments — is derived from Postgres into `hydration.json` at launch
and never replayed. Inputs arrive by tier; output is one tree, mirrored out by the agent.

- `ROADMAP.md` — the architecture and the argument for each choice.
- `DECISIONS.md` — what was built, what was stubbed, and the claims I trust least. Start
  here if you only read one.

## Layout

| Path | What it is |
|---|---|
| `web/` | Next.js front end and API. Intake, review with pinned regions, deploy. |
| `eval/` | Launchers, hydration, the brand toolkit, and every test suite. |
| `sandbox/` | The two E2B templates and the two agents that run inside them. |
| `supabase/` | Schema, row-level security, roles. Isolation lives here. |
| `campaigns/` | Request payloads used for local runs. |
| `image_testing_v2/` | Gate 0 — the skill run locally for both brands, before anything touched a sandbox. |
| `results/` | Interleaved concurrent runs: per-tenant hydration, the renders each one saved, and the launcher logs. |
| `new customers/` | Brand kits for onboarding through the UI, including ones that are meant to fail. |
| `transcripts/` | Every agent session, rendered. |
| `TRANSCRIPT*.txt` | The main session, untidied — the summary and the complete record. |

## Running it

Requires Node 22+, and `.env` at the repo root (see `.env.example`). Keys are read from
the environment and never committed.

```bash
npm install --prefix eval
npm install --prefix web
npm install --prefix sandbox

npm run build --prefix sandbox     # builds both E2B templates and writes a build stamp
npm run dev --prefix web           # http://localhost:3100
```

The launchers refuse to start a box when the build stamp disagrees with source, so if you
edit an agent or a skill, rebuild. `npx tsx sandbox/check-stamp.ts` answers "do I need
to?" without spending a build.

Freshness is tracked **per template**, so editing the deploy agent does not block a
generation run — each launcher asks only about the image it is starting. Rebuild one with
`npm run build:deployment --prefix sandbox` rather than both.

## Verifying it

```bash
npm test --prefix eval                 # 297 tests, no network, no database
npm run test:isolation --prefix eval   # 62 tests against the live database
npm run e2e --prefix web               # 25 tests through the real interface
```

**Run the second one.** The first suite deliberately touches nothing external, which
means the guarantee this whole design rests on — that one customer cannot reach another's
brand — is *not* covered by it. `test:isolation` is the suite that proves it: real
Postgres, real storage, real policies, including the packet's own mis-tagged asset used
as a planted leak that the wrong tenant must not see.

It needs `SUPABASE_DB_URL` in `.env` and the project's CA bundle at
`.certs/supabase-ca.crt` (Supabase dashboard → Settings → Database → SSL certificate).
The certificate is not committed because it is not ours to redistribute. Without either,
the suites **skip themselves loudly** rather than passing — a green run that never
connected is the failure this layer exists to prevent.

The third drives the product itself with Playwright against the dev server on port 3100 —
sign-in and cross-customer isolation from the browser, the review screen's regions, the
deploy screen, and the API refusing what it should: a forged session cookie, a revision id
that is really a flag, an upload claiming another customer, a path masquerading as a
filename. Start `npm run dev --prefix web` first.

Other suites, opt-in because they spend money or write real rows:

```bash
npm run test:brand --prefix eval   # brand acceptance and the plate pipeline
npm run test:live  --prefix eval   # makes a real gpt-image-2 call
npm run verify     --prefix eval   # end-to-end product check; writes rows and objects
```

