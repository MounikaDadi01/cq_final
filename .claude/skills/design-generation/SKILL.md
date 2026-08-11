---
name: design-generation
description: Create or revise a customer-facing ad from a Design Brain. Use for ads, social tiles, and banners. Do not use for copy-only work or list enrichment.
---

# Design generation

Build one polished, brand-faithful ad at a time. This is a reduced build of the
production skill: fixed-canvas ads only. Landing pages, emails, decks and
multi-page series have been removed.

No code ships with it. Everything described here, you build.

## Non-negotiable invariants

1. **Every ad is plate-first.** One full-canvas raster plate, plus live HTML
   overlays for all text, logos and CTA labels. Nothing else.
2. **One plate per canvas size.** A plate is generated at the exact target
   pixel dimensions and used at exactly those dimensions. Never crop, stretch,
   letterbox, pad or re-frame one plate into a different aspect ratio. Four
   sizes means four plates.
3. **Every word in the finished ad is live HTML.** Headline, subhead, body,
   eyebrow, legal, CTA label, every one of them a text node you could select
   with a cursor. No campaign text is baked into the plate, and no copy is ever
   rasterised to match a reference.
4. **A logo is a placed file at its natural proportions.** Use the staged asset
   from the manifest. Scale it by constraining one dimension and letting the
   other resolve, or fit it inside a larger transparent box. Never stretch,
   squash, crop, recolour, redraw, typeset or skew a logo, and never apply
   unequal X and Y scale to one.
5. **`DESIGN.md` is the brand.** Where any other artifact disagrees with
   `DESIGN.md` — a token cache, a manifest, an inspiration, a prior asset, a
   value the request itself supplies — `DESIGN.md` wins.
6. **Inspirations are treatment reference and nothing else.** Never a source of
   colour, type, spacing, radius or any other token. Never a source of copy.
   Never a source of an asset.
7. **Never publish.** A generation run stages files and writes `RESULT.json`.
   It does not deploy, upload to an ad platform, or announce that it has.

If a request conflicts with an invariant, keep the invariant, take the allowed
alternative, and say in `RESULT.json` what you could not do.

## Resolution order

Read in this order:

1. `TASK.md` — the request: brand, canvas sizes, copy, any attached inspiration.
   `TASK.md` defines the job, not the brand. Where a request supplies a brand
   value, invariant 5 applies and `DESIGN.md` wins.
2. `DESIGN.md` — palette, type, type scale, shape, voice, and the prose rules
   under *Applying it*, which are as binding as the numbers above them.
3. `brand/asset_manifest.json` — staged logo and media paths, with kit ids.
4. `fonts/` — the families the brand actually ships.

A brain may also carry `brand/tokens.json`, a machine-readable export from
brand-sync. It is a convenience for tooling. It is not the brand, it has no
authority, and it is not permitted to contribute a value that `DESIGN.md`
also states.

## Brand binding

- The request pins one brand kit id. Use only manifest assets whose
  `brand_kit_id` equals it.
- Never infer or substitute a kit from campaign state, an inspiration, a
  filename, a folder the file happens to sit in, or a similarly named customer.
- Every asset you place must resolve to a file you can open. A path is not an
  asset.
- Every family named in `DESIGN.md` must be loaded from that brain's `fonts/`
  and applied in the render. Browser fallback is not the brand.
- If a required asset is unavailable, omit it or escalate. Never typeset a text
  substitute for a logo, and never borrow a logo from anywhere else.

## Inspirations

Inspirations are reference designs from the customer's own library. They show
composition, rhythm, crop, and how the brand behaves on a canvas. They are
advisory.

- Consult one only when the request attaches it by filename. An inspiration
  that merely sits in a directory is not selected and must not influence the
  build.
- Do not sample colours from an inspiration. Do not measure type off it. Do not
  copy its words. Do not extract, trace or reuse any part of it as an asset.
- An inspiration is a picture of one past decision, not a rule. Where it and
  `DESIGN.md` describe different brands, `DESIGN.md` is the brand.

## Plate-first: what it means

Every fixed canvas is one full-bleed raster plate with live HTML on top. The
plate carries the entire visual treatment. The HTML carries every word.

### Selecting the plate source

| Situation | Plate source |
|---|---|
| New design from references | Generate one textless, logo-free full-canvas plate at the exact target dimensions. |
| Adapting a fixed-canvas template | Render the full source canvas, then wipe all campaign text, logos and CTA labels from that complete raster. Keep the visual treatment. |
| Revising an existing output | Keep the plate only if it is still text-, logo- and CTA-free. Otherwise wipe or regenerate it. |

Do not clone the source DOM as the visual composition. Do not use an isolated
hero photo as the whole plate. Do not build the background from gradients, CSS
shapes or decorative DOM fragments — if the treatment is geometric, the
geometry belongs in the plate.

### The generation prompt contract

Describe composition, subject, lighting, palette, texture, material, negative
space and the exact aspect ratio. Explicitly prohibit words, letters, numbers,
logos, badges, button labels, watermarks, signatures and UI-like text. Supply
brand colours and reference imagery. Never ask the image model to reproduce a
logo, and never ask it to leave room for text you then do not place.

Generate separately for every canvas size. Save each plate under
`html_<slug>/assets/` and place it at exact canvas bounds, uncropped and
unstretched.

### The HTML overlay contract

- Exactly one fixed canvas root, explicit pixel width and height, clipped overflow.
- Exactly one full-canvas local raster plate, referenced by a path inside the project.
- Every headline, body line, legal line, label, logo and CTA word is a positioned HTML or SVG overlay.
- Overlays carry stable roles: `data-cq-role="text"`, `data-cq-role="logo"`, `data-cq-role="cta"`.
- No element in the overlay layer draws anything except text, a logo, or a CTA.
- A logo keeps its intrinsic proportions. A wrapper may size and position it; the image itself uses `max-width:100%`, `max-height:100%`, `width:auto`, `height:auto`, `object-fit:contain`.
- Copy is real selectable text and links are real links. Never convert copy or a logo to pixels to match a reference.

### Structural checks

Each of these is true or false. Settle every one before you go further:

- Canvas width, height and aspect ratio are exactly as requested.
- The plate fills the canvas with uniform scale on both axes.
- The plate carries no readable campaign text, no logo and no CTA.
- Every required string is present, as an overlay, in bounds, and not
  overlapping another overlay.
- Every logo's rendered aspect ratio matches the asset's natural ratio within
  rounding tolerance.
- Every asset reference resolves inside the project.
- Every font family in use came from the brain.

## Look at it

Render the canvas to PNG. Open the PNG. Look at it.

The PNG is what the customer sees; the HTML is not. Those two can drift apart
without either one looking wrong, so a check that reads the HTML has verified a
file nobody will ever look at.

Look at the render and answer, in your own words, before you call anything done:

- Can you read the headline from across the room, and is it the first thing you
  read?
- Is the copy sitting on a part of the plate quiet enough to hold it, or on the
  busiest part of the photograph?
- Does the logo survive the ground it is on, at the size it is at?
- Is the CTA obviously the thing to click, or is it decoration?
- Put it next to the brand's own work. Does it look like the same company made
  it, or like something roughly the right colour?
- What is the worst thing about this ad? Say it out loud even if the request
  did not ask.

This section has no pass criteria and cannot be automated. Do not build a
program that decides whether an ad is on brand: it will pass ads a person would
reject and reject ads a person would ship, and you will trust it. Every rule
above this section can be satisfied in full by an ad that is worth nothing. The
only instrument that catches that is your own eyes on the render, and an output
file existing is not evidence that anyone used them.

## Finish

Write `RESULT.json`: the staged project paths, the rendered PNG per canvas
size, a completion or escalation status, and anything in the brand data you
could not reconcile together with what you used instead. Do not claim
publication.
