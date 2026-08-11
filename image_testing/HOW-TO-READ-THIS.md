# How to read what's in here

Plain-English guide to every folder, file, tag and number the generator produces —
so you can check the output without reading the code.

---

## 1. What actually happens, in order

For each campaign, for each canvas size:

1. **Resolve the brand.** Read `DESIGN.md` for the palette, type scale and shape.
   Read the manifest for logos. Read `fonts/` for the faces that actually exist.
2. **Work out a legal size to ask the image model for.** None of the four canvases
   can be requested directly — see §5.
3. **Generate the plate.** One image-model call per canvas. The plate is the
   *background only*: no words, no logo, no button.
4. **Reduce the plate** to the exact canvas size.
5. **Build the overlay** — an HTML file where every word is real text sitting on
   top of the plate.
6. **Render** the HTML to PNG at exactly the canvas size, in a real browser.
7. **Measure** the result and run the checks against it.

The critical idea: **the plate is a photograph, the words are not.** Nothing is
ever "baked into" the image. That's why type is always crisp and why an edit to
a headline doesn't need a new photo.

---

## 2. Folder layout

```
image_testing/
  <campaign-id>/
    html_square/
      index.html          the ad: plate + live text
      assets/plate.png    the background photograph, alone
      kahua-mark.svg      the logo file, copied in
    html_landscape/ …
    html_portrait/ …
    renders/
      square.png          ← THE FINISHED AD. This is what a customer sees.
      landscape.png
      portrait.png
    RESULT.json           what happened, per canvas
  RESULT.json             all campaigns together
```

**Look at `renders/*.png`.** Everything else is workings.

`html_<size>/assets/plate.png` is worth opening once, to confirm the plate really
contains no text or logo — the words you see in the render are all HTML.

---

## 3. Campaign file — every field

Campaign files live in `../campaigns/` and are **local test fixtures only**.

| Field | Plain English |
|---|---|
| `id` | Folder name for the output |
| `brand_kit_id` | Which brand's assets may be used. **Nothing outside this kit is ever touched** |
| `campaign` | The campaign name, for the record |
| `kind` | `new` = generate from scratch. `edit` = revise an existing revision |
| `canvases` | The sizes to produce, each with exact pixel width and height |
| `copy.eyebrow` | Small label above the headline, e.g. "CASE STUDY" |
| `copy.headline` | The big line |
| `copy.subhead` | The supporting sentence |
| `copy.cta` | The button text |
| `copy.cta_href` | Where the button points |
| `copy.legal` | Small print. `null` when there is none |
| `plate_direction` | **The photo brief.** What the background should show — subject, lighting, colour, and where to leave empty space |
| `inspirations` | Reference images, by exact filename. Empty means none. Used for *composition only* — never for colour or copy |
| `style` | Layout intent read out of `DESIGN.md` by a person — see §4 |
| `notes` | Free text for us |

### Why `plate_direction` matters most

It becomes the image prompt. The generator always appends the prohibitions:

> no words, letters, numbers, captions, logos, wordmarks, badges, buttons, button
> labels, UI text, watermarks, signatures or any typography of any kind

If the plate comes back with text in it, the prompt needs strengthening — not the
overlay.

The phrase to pay attention to is the one about **empty space**. If the direction
says "the lower half falls into deep shadow and holds no detail", the copy is going
to sit there. Plate and layout have to agree, or the words land on a busy area.

---

## 4. `style` — every field

| Field | Plain English |
|---|---|
| `ground` | `dark` or `light` — a *hint only*. **Now overridden by measurement**: the plate's actual brightness where the copy sits decides whether text is white or near-black. One campaign declares `dark` and its plate came back overcast, so the measurement flips it |
| `copyArea` | Where the words go: `upper`, `lower`, or `left`. Must match where `plate_direction` promised empty space |
| `logoPosition` | Legacy hint. **Now ignored** — the logo's corner is chosen by measuring the plate, see §7 |
| `eyebrow` / `headline` / `subhead` | Type settings, below |
| `cta` | Button settings, below |

**Type settings**

| Field | Plain English |
|---|---|
| `colour` | A *name* from the brand palette (`accent`, `surface`, `ink`…), never a raw hex. Resolved from `DESIGN.md`, so it cannot drift from the brand |
| `size` | e.g. `48px`. Comes from the brand's type scale |
| `weight` | 400 normal, 600 semibold, 700 bold. **Falls back to the nearest weight the brand actually ships**, tie broken heavier |
| `tracking` | Letter spacing. Positive spreads letters out, used for small uppercase labels |
| `leading` | Line height as a multiple. `1.02` = very tight, for big headlines |
| `uppercase` | Forces capitals |

**Button settings**

| Field | Plain English |
|---|---|
| `fill` | Palette name for the background, or `none` for outline-only |
| `label` | Palette name for the text |
| `border` | Palette name for a 2px outline. Omitted for solid buttons |
| `radius` | `4px` = slightly rounded. `999px` = full pill |

The two brands differ here, and it's from their own documents. One says a button is
a **solid orange fill with a white label**. The other says orange is *never* a fill
and a button is an **orange label inside a 2px orange outline**. Same palette,
opposite instruction.

---

## 5. The size arithmetic — why "generate at 1088" for a 1080 canvas

The image model only accepts sizes where **both edges divide by 16**. None of the
four canvases does. So for each one we ask for the nearest legal size *above*
target with the same shape, then shrink it.

| Canvas | Asked the model for | Shrunk by | Distortion |
|---|---|---|---|
| 1080×1080 | 1088×1088 | same on both axes | **none** |
| 1080×1350 | 1088×1360 | same on both axes | **none** |
| 1200×628 | 3088×1616 | very slightly different | **0.0033%** — 0.04px across the whole canvas |
| 728×90 | *nothing* | — | **cannot be produced** |

Shrinking is done by averaging, which is the correct way down — it loses detail
evenly instead of going blocky. We never *enlarge*, because that invents detail
that was never photographed.

**Why 1200×628 can't be perfect:** its shape is 300:157, and 157 is a prime
number, so the smallest matching legal size is 4800×2512 — past the model's
3840px maximum. The 0.04px left over is smaller than one pixel.

**Why 728×90 is impossible:** it's 8 times wider than tall, and the model refuses
anything beyond 3:1. It also asks for far fewer pixels than the minimum. Two
independent refusals. Bhairav confirmed this is a deliberately planted bug and
said to skip it — so that canvas is reported and left out.

---

## 6. The tags inside `index.html`

Open one and you'll see attributes like `data-cq-role`. They label what each
element *is*, so a machine can check the ad without guessing.

| Tag | Meaning |
|---|---|
| `data-cq-role="text"` | A word or line of copy. Real selectable text |
| `data-cq-role="logo"` | The logo. An image file, never typed out |
| `data-cq-role="cta"` | The button |
| `data-cq-line="eyebrow"` | Which line of copy this is — `eyebrow`, `headline`, `subhead`, `legal` |
| `id="canvas"` | The fixed frame. Exact pixel size, anything outside is clipped |
| `id="plate"` | The background photograph, filling the frame edge to edge |
| `id="stack"` | The column holding eyebrow, headline, subhead and button |

**Rule:** nothing in the overlay draws anything except text, a logo, or a button.
No decorative boxes, no gradients, no shapes. If the design needs geometry, the
geometry belongs in the photograph.

**`@font-face` with a `file://` address** appears at the top of the CSS. This is
load-bearing and easy to get wrong: a browser will silently ignore a font file
sitting in a folder and substitute something else. The ad still *looks* fine and
the typeface is wrong. So every render is checked — see §8.

---

## 7. How the logo's position is chosen

Not by a rule about corners. The plate already exists, so its bright and dark
areas are facts we can read.

1. Pick the corners that don't collide with the copy — if words are at the top,
   the logo goes to the bottom.
2. **Measure the brightness** of the plate in each remaining corner.
3. Pick the strongest logo the brand has that will read there.

Preference: the **wordmark** first, because it contains the company name. A symbol
comes second — it identifies the brand only to someone who already recognises it.

One brand's manifest lists a white version of its logo but **the file is missing**
— another planted bug. So on dark grounds it falls back to the hexagon symbol. You
can see this in `RESULT.json` as `logo_corners_considered`, listing every corner,
its brightness, and what could go there.

---

## 8. `RESULT.json` — every field

**Per campaign**

| Field | Plain English |
|---|---|
| `quality` | `high` for anything shown to someone, `low` for cheap drafts |
| `resolved.heading_family` | The typeface actually used for headlines |
| `resolved.heading_substituted` | `true` means the brand asked for a face it doesn't ship |
| `resolved.heading_note` | What was substituted and why |
| `resolved.h1` | The headline size, and where it came from. `48px (prose, contested)` means the brand's own document said two different things and the sentence won over the table |
| `findings` | Things worth a person's attention that didn't stop the run |

**Per canvas**

| Field | Plain English |
|---|---|
| `target` | The size requested |
| `generated` | The size actually asked of the model |
| `anisotropy_pct` | How unevenly it was shrunk. `0` is perfect; `0.0033` is 0.04px |
| `fonts_ok` | **`true` means every word rendered in a real brand font.** `false` means a silent substitution — treat the render as unusable |
| `computed_fonts` | What the browser actually used per line. Names all start `brain-` |
| `logo` / `logo_corner` | Which logo file, and which corner |
| `logo_corners_considered` | Every corner, its brightness, and what could go there |
| `copy_ground` | The brightness measured where the copy sits, whether that was treated as dark or light, and what the campaign had *declared*. A mismatch between `treatedAs` and `declared` is the measurement doing its job |
| `text_colour_corrections` | Any line redrawn because it could not be read against the plate beneath it, with the before and after ratios. Empty is the normal case |
| `measured` | The exact position and size of every element, read back out of the render |
| `check_failures` | Rules broken. **Should be empty** |
| `check_unverifiable` | Checks that *couldn't run* — different from passing. Something wasn't measurable |
| `contrast` | Readability, 1 to 21. Above ~4.5 is comfortable, 3 is the floor for large type. **Measured against the plate, not the render** — see below |
| `seconds` | How long the plate took |

`check_unverifiable` deserves attention: it exists so "nothing failed" and
"nothing was checked" can never look the same.

**Why contrast is measured against the plate.** The obvious way — read the colours
inside a line's box in the finished render — counts the letters themselves as part
of their own background. A white headline made its own box read as white and
reported a ratio of 1.0, which says "text against itself" rather than anything
about legibility. The plate has no type in it by construction, so the plate under
a line's box is its background, and the reading stops depending on the answer it
is trying to produce.

---

## 9. What's checked automatically, and what isn't

**Checked by software** — these have exact answers:

- The render is exactly the requested pixel size
- The plate fills the canvas, shrunk evenly on both axes
- Every colour used appears in the brand palette
- The colour the HTML declares is really present in the pixels
- Every word rendered in a font the brand ships
- The logo resolves to a real file, belongs to this brand, and keeps its proportions
- Every required line of copy is present, inside the frame, not overlapping

**Deliberately not checked by software** — no exact answer exists:

- Whether the ad is any good
- Whether the photograph suits the brand
- Whether orange is used as a *fill* or an *outline* — the palette check sees the
  colour is allowed, not how it's used. The button's declared colour *is* confirmed
  present in the pixels, at a coverage bar that depends on which of the two it is:
  a solid fill must dominate its box, an outline only has to be there
- Whether the composition is well balanced

Those are judged by looking at the render. Software that scored them would pass
work a person would reject.

---

## 10. Quick way to review a batch

1. Open every `renders/*.png`.
2. For each, ask: can you read the headline immediately? Is the copy on a quiet
   part of the photo? Does the logo survive its background? Is the button
   obviously the thing to click? Put it beside the brand's real work — same
   company?
3. Then check `RESULT.json` for `fonts_ok: true` and an empty `check_failures`.
4. Anything in `check_unverifiable` or `findings` is worth a glance.

If a render looks wrong, the cause is usually one of:

- **Words on a busy area** → `plate_direction` and `copyArea` disagree
- **Wrong-looking typeface** → `fonts_ok` will be `false`
- **Logo hard to see** → check `logo_corners_considered`; the plate may have no
  quiet corner
- **Text in the photograph itself** → the plate prompt needs strengthening

Layout problems are cheap to fix: the plates are already on disk and can be
re-rendered without paying for new images.
