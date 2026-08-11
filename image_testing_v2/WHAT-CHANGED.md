# What changed between `image_testing/` and `image_testing_v2/`

Written after Bhairav's feedback on the first batch:

> "Not using correct logo for either co! Emplifi's designs in general seem a bit
> wonky - check to make sure inspirations are actually being attached and used!"

This records what was wrong, what changed, what is now verified, and — separately
— **what was not fixed**. The last section matters most: one of his two points is
only partly addressed, and one campaign in this batch sidesteps a problem rather
than solving it.

---

## 1. Logo variant chosen from the ad's ground, not a corner patch

**What was wrong.** `placeLogo` sampled each candidate corner, let each corner
nominate its own logo variant, then ranked the nominations by how "decisive" the
corner was. On a navy Emplifi plate averaging 0.015 luminance, a corner holding a
bright product screenshot measured 0.939 — so that corner won, and with it the
*dark* logo went onto a navy ad.

Local brightness is evidence about a corner. It was being used as evidence about
the design.

**What it is now.** The variant is chosen once, from the mean luminance of the
whole plate. Corners only decide *position*, and only among corners that suit the
variant already chosen.

**Evidence in this batch** (`RESULT.json` → `logo_ground`):

| Canvas | Plate mean | Variant | Asset |
|---|---|---|---|
| emplifi square | 0.038 | `logo_reverse` | `emplifi-logo-white.svg` |
| emplifi landscape | 0.046 | `logo_reverse` | `emplifi-logo-white.svg` |
| kahua square | 0.939 | `logo` | `kahua-logo.svg` |
| kahua landscape | 1.000 | `logo` | `kahua-logo.svg` |

File: `eval/src/logo-placement.ts` (rewritten).

---

## 2. Straddle detection — a logo half on light, half on dark

**What was wrong.** In the first batch the `emplifi` wordmark sat across the edge
of a laptop screenshot: half on white, half on navy. The corner's *mean* was
plausible, so nothing objected. A mean cannot detect a boundary running through
the middle of a box.

**What it is now.** The logo's footprint is divided into a grid (4×2 by default)
and every cell is tested against the switch point. A corner is eligible only if
**every** cell agrees with the ad's ground. If no corner is clean, the least
conflicted is used and `straddled: true` is recorded rather than hidden.

**Evidence.** All four canvases report `0/8 cells disagreeing`, `straddled: false`.

---

## 3. The switch point comes from the brand, not from us

**What was wrong.** A single constant, `DARK_GROUND_LUMINANCE = 0.179`, decided
"dark" for every brand — while Kahua's manifest states its own threshold:

> `logo_reverse` … "For placement on photography and any ground darker than
> `#6B7A88`."

**What it is now.** `groundSwitchPoint()` reads the first hex colour out of the
manifest note for the kind being placed and uses its luminance. It falls back to
the computed crossover only when a kit is silent.

`#6B7A88` → luminance **0.188**. Our constant was 0.179 — close, but the point is
that a brand stating its own rule now governs, and it is per-kit data rather than
one number for everybody.

**Evidence.** Kahua rows read `switchPointSource: "logo_reverse note names #6B7A88"`.
Emplifi states no threshold, so its rows read `"no threshold stated by the kit;
computed crossover"`.

File: `eval/src/brain.ts`.

---

## 4. Inspirations actually reach the model

**What was wrong.** Nothing attached them. `plate.ts` declared a
`referenceImages` field, `platePrompt()` never mentioned inspirations, and
`openai-image.ts` had no multipart support at all — it only ever called
`/v1/images/generations`, which accepts no image input. The plumbing stopped at a
type declaration.

Six of seven campaigns in the first batch also declared `inspirations: []`, so
even the fixtures dodged the feature.

This was against an explicit instruction in SKILL.md:

> "Describe composition, subject, lighting, palette, texture, material, negative
> space and the exact aspect ratio… **Supply brand colours and reference
> imagery.**"

**What it is now.** When a request attaches inspirations by filename, the call
goes to `/v1/images/edits` as multipart form-data with a repeated `image[]` field.
The size envelope is identical on both endpoints, so the existing size arithmetic
is unaffected.

**The reference is bounded to composition**, because SKILL.md pulls two ways —
supply reference imagery, but "do not sample colours from an inspiration." The
prompt therefore states that references govern composition, rhythm, crop and
negative space only; that the palette overrides anything they show; and that no
text, wordmark, logo or button may be copied from them.

That bound is not academic. **Emplifi's own inspiration breaks Emplifi's palette
rule** — `emplifi-predictions-square.png` uses a solid orange pill CTA at 6.32%
coverage, while `DESIGN.md` says orange is "never used as a fill." An unbounded
reference would propagate a brand violation into the plate.

**Evidence.** `inspirations_attached: ["emplifi-shoppable-video.png"]`, and the
plate at `v2-emplifi-commerce-signals/html_square/assets/plate.png` contains the
circle cluster and sweeping arc from the reference's composition with **no type,
no wordmark and no UI** — checked by eye.

Files: `eval/src/openai-image.ts`, `eval/scripts/gate0.ts`.

---

## 5. No brand-specific palette names left in code

**What was wrong.** Six places looked up the palette keys `surface` and `ink`.
Both kits here happen to use those names, so it worked on two brands. A third kit
naming them `background`/`foreground` would return `undefined` — and the failure
would be **silent**, because an absent candidate simply means no colour is ever
corrected. Unreadable ads with a clean report.

**What it is now.** `paletteExtremes()` returns the lightest and darkest colours a
kit publishes, found by luminance, whatever they are called. Any kit with a
palette has a lightest and a darkest member.

`grep -rn "'surface'\|'ink'" eval/src eval/scripts` (excluding tests) returns
nothing.

Files: `eval/src/brain.ts`, `eval/src/overlay.ts`, `eval/scripts/gate0.ts`.

---

## 6. Output directory is a parameter

`CQ_OUT=image_testing_v2` selects the output tree, so a new batch never overwrites
one you are still reviewing.

*Known cosmetic bug: the final console line still prints the literal string
`image_testing/` regardless of `CQ_OUT`. The files go to the right place; the
message lies.*

---

## What is verified in this batch

| | Emplifi | Kahua |
|---|---|---|
| Correct logo variant | ✓ | ✓ |
| Straddle-free placement | ✓ 0/8 | ✓ 0/8 |
| Switch point source | computed | **own manifest note** |
| Inspiration attached | ✓ | none declared |
| Plate free of type/logo | ✓ checked by eye | ✓ |
| Check failures | 0 | 0 |
| Min text contrast | 11.95 | 15.50 |

216 tests pass. Typecheck clean.

---

## What was NOT fixed

### The Kahua misfiled logo is untouched, and this batch avoided it

`partner-lockup.svg` sits in **Emplifi's** manifest, labelled `logo_lockup`, noted
"Co-marketing lockup, reverse" — and is, in fact, **Kahua's missing reverse
logo**. Geometry is byte-identical to `kahua-logo.svg` once fills are stripped,
`aria-label="kahua"`, `brand_kit_id: bk-kahua-2026`. Only the fills differ:
wordmark `#FFFFFF` instead of `#16202B`. There is no partner in it.

**Nothing was implemented for this.** Specifically:

- `DEFAULT_LOGO_PREFERENCE.dark` is still `['logo_reverse', 'logo_mark']`, so a
  dark Kahua plate still silently substitutes the hexagon mark.
- No omit-or-escalate path was added, though SKILL.md names that remedy: "If a
  required asset is unavailable, omit it or escalate."
- No finding is emitted saying an asset tagged for this kit exists elsewhere. The
  existing `asset-foreign-kit` finding describes the file by its manifest label,
  not by what is inside it.
- No cross-manifest resolution exists.

**And the Kahua campaign in this batch was written as bright overcast daylight**,
so the plate came back at 0.939 and 1.000 — light — and the dark path never ran.
That render is correct because the missing asset was not needed, not because the
misfiling is solved.

Do not read a correct light-ground Kahua render as evidence that Kahua's logo
problem is fixed. **6 of 9 canvases in the first batch sat on dark plates, and
none of them can be done correctly with what the kit ships.**

The reason it is unimplemented rather than merely unfinished: the compliant
remedy is genuinely ambiguous, and picking wrong is worse than waiting.

| Option | Basis | Problem |
|---|---|---|
| `logo_mark` hexagon | a real Kahua asset | substitutes a different *kind*; ad loses the company name |
| Omit | "omit it or escalate" | ad carries no identity |
| Escalate | same line | needs a human — possibly the honest answer |
| Use `partner-lockup.svg` | its `brand_kit_id` **is** Kahua's | "never borrow a logo from anywhere else"; wrong `kind`; another kit's manifest |
| Recolour `kahua-logo.svg` | — | **forbidden by name**: "never … recolour … a logo" |

Which one is right determines whether the planted bug is *"detect the misfiling
and reunite the asset with its owner"* or *"detect the missing asset and escalate
rather than degrade."* Those imply different resolvers, so it is a question for
Bhairav.

### No model looks at the output

AdGeneration.md says:

> "The model can read images. **Have it look at what it made before anything calls
> itself done.**"

Not implemented. Every check in this pipeline is a deterministic measurement —
pixel dimensions, aspect ratio, contrast ratios, font provenance. None of them can
see that a wordmark is sitting on a laptop, or that a composition does not look
like the brand. Both of Bhairav's comments are things a model reviewer catches and
a measurement reviewer structurally cannot.

In this batch that role was performed by a human reading four PNGs. That does not
scale, and it is the largest remaining gap.

### Trade-off worth seeing

Emplifi's eyebrow was declared `secondary` (periwinkle `#6765FE`) and measured
**2.77:1** on navy — below the 3:1 floor for large text — so it was corrected to
white at 11.95:1. Readable, but Emplifi's periwinkle is lost on that line.
Recorded in `text_colour_corrections`. Arguably the campaign should not ask for
periwinkle small-caps on a navy ground in the first place.
