# Design engine

An agent that takes a customer's brand, generates a designed ad, lets a human iterate on
it, and pushes it into the customer's marketing tool.

The governing idea, from the brief: **everything is a file system — files and skills,
hydrated in different orders at different times.** Every event here is the same event. A
clean box spins up, the right files go in, an agent gets a prompt, the agent works, **the
agent saves its own work**, the box dies.

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
| `TRANSCRIPT*.txt` | Raw agent transcripts, untidied. |

## Running it

Requires Node 22+, and `.env` at the repo root (see `.env.example`). Keys are read from
the environment and never committed.

```bash
npm install --prefix eval
npm install --prefix web
npm install --prefix sandbox

npm run build --prefix sandbox     # builds both E2B templates and writes a build stamp
npm run dev --prefix web           # http://localhost:3000
```

The launchers refuse to start a box when the build stamp disagrees with source, so if you
edit an agent or a skill, rebuild. `npx tsx sandbox/check-stamp.ts` answers "do I need
to?" without spending a build.

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

## The disqualifiers

`eval/tests/disqualifiers.test.ts` scans the repository for each of the brief's
disqualifiers that has an exact answer, and every scanner is fed a planted violation so a
green run means it looked rather than that it found nothing. It asserts a floor on the
number of files read, because an earlier version pointed at directories that did not
exist and passed by scanning zero of them.
