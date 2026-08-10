# Evaluation layer

Ships before the thing it grades. 190 tests, no browser, no cloud, and no image
model unless you ask for one.

```bash
cd eval
npm install
npm test           # extracts the packet, then runs everything. Spends nothing.
npm run test:brand # the hardcoded acceptance suite + the plate pipeline
npm run test:live  # ONE real gpt-image-2 call. Costs money. Opt-in only.
npx tsc --noEmit   # typecheck
```

## What it covers

| Suite | Subject |
|---|---|
| `capability.test.ts` | The image model's size envelope, and what to generate at for a given canvas |
| `brain.test.ts` | Brain loading, palette parsing, generic font substitution |
| `checks.test.ts` | Render checks: dimensions, uniform scale, palette, pixel fidelity, fonts, assets, copy, bounds, overlap, roles |
| `disqualifiers.test.ts` | Static scanners, one per listed disqualifier with an exact answer |
| `ingest.test.ts` | Brain ingest planning, including a brand that exists nowhere in the packet |
| `silent-cases.test.ts` | Input software cannot read — every case that used to pass quietly |
| `logo-ground.test.ts` | Choosing a logo for the ground it sits on, when a reverse mark is missing |
| `brand-acceptance.test.ts` | **Hardcoded** expectations for the two brands in the packet |
| `plate-pipeline.test.ts` | Plan → generate → reduce to exact target, with the image call faked |

## Two suites, opposite jobs

The main suite **derives** every expectation from the brain, so it would pass for a
brand nobody has seen. That proves the *mechanism* is brand-agnostic. It cannot
prove the *outcome* is right — generic code can resolve a value with complete
confidence and be wrong, and every derived assertion still passes.

`brand-acceptance.test.ts` is the complement, and it **hardcodes on purpose**:
Kahua's h1 is 48px, its accent is `#F26B21`, its heading substitutes to Barlow 700,
its reverse logo does not exist. Emplifi's secondary is `#6765FE` and not the
cache's `#5B5BD6`. If the resolution logic drifts, a number changes here and the
failure names the exact value.

Hardcoding is safe in that file and nowhere else: the tenant-name scanner reads
`app/`, `api/` and `src/`, never `tests/`. Product code stays brand-blind.

## Two rules it is built on

**Nothing names a customer.** Tenant names, kit ids, palettes, fonts, logo
proportions and canvas sizes are all discovered — brains from the directory that
holds them, canvases from the request payloads in the packet. Pass in a brand
nobody has seen and the same assertions run against *its* values. The scanner
that forbids tenant names in source takes the tenant list as an argument, so a
third brand is covered the moment it lands on disk.

**Every detector is shown catching something.** Each check has two tests: it
passes a compliant render, and it fails a planted violation. A detector that has
never fired is indistinguishable from a clean codebase, and "no leaks found"
from a scanner that finds nothing looks exactly like success.

The cross-tenant fixture is real rather than synthetic: the packet already ships
an asset tagged to one kit sitting inside another brain's manifest. `brain.test.ts`
asserts that hazard still exists, so if the fixture ever disappears the leak test
fails loudly instead of passing vacuously.

## Three outcomes, not two

`pass`, `fail`, and **`unverifiable`**. The third exists because a check that
cannot run must say so rather than imply success — an SVG declaring no intrinsic
size, a font filename we cannot index, a palette written in Pantone. Each of
those produced a silent pass before, which is the same failure as a detector that
never fires.

`failures()` returns only real failures. `unverified()` surfaces the gaps, so
"nothing failed" and "nothing was checked" can never look alike.

## Checks with exact answers only

Canvas geometry, scale uniformity, colour provenance, font provenance, asset
resolution and kit ownership all have exact answers, so software owns them.

Whether an ad is any *good* has no exact answer and is deliberately absent.
Software that grades brand conformance passes work a person would reject and
rejects work a person would ship. That judgement belongs to the model looking at
the rendered PNG.

## The check that matters most

`pixel-fidelity` samples the region an overlay occupies and asks whether the
pixels a customer will actually see carry the colour the HTML declared. A check
that only reads the HTML has verified a file nobody looks at, and the two drift
apart without either one looking wrong.

## Deliberately not covered yet

- Anything requiring a live sandbox. These run locally, by design — the skill has
  to make ads worth defending before hydration is worth debugging.
- Chromium font loading. A TTF in a directory is not used unless it is installed
  into fontconfig or loaded via `@font-face` with a `file://` src; the assertion
  for that needs a real render and lands with the renderer.
- "A hardcoded ordering." It cannot be settled by reading source. It is proven by
  running the interleaved concurrent case and observing that nothing crossed.
- **Prose rules inside a token line.** `readSection` strips trailing
  parentheticals, so a radius written as `12px (CTA buttons are pill-shaped)`
  loses the pill instruction. That costs the product nothing — the agent reads
  `DESIGN.md` whole and no backend code parses it — but this suite cannot check
  pill-versus-square CTAs, and saying so beats implying coverage.
- **Contrast acceptability.** The ratio is computed and reported by
  `measureContrast`; whether it is good enough is the model's judgement.

## Found by these tests already

The first draft of the fixture builder clamped a logo's width without recomputing
its height, which is an unequal X and Y scale. `logo-aspect` caught it on the
portrait canvas for both brands before any real render existed.
