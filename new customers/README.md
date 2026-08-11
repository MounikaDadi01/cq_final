# Four brand kits, for testing intake

Drop a folder into the Add customer screen. Each one is here to prove a different
thing, and three of them are deliberately wrong.

Read this before you judge the results: **only one of these should produce clean
ads.** The others are here to check that the system degrades in the right order —
reports what it cannot do, refuses what it must not guess at, and never quietly
substitutes something plausible.

---

## 1 · northwind-foods — correct

Mirrors the packet's own format exactly: `DESIGN.md` with palette, type, scale, shape
and prose rules; a manifest with `logo`, `logo_reverse` and `logo_mark`; four font
weights; a token cache that agrees with the brand.

**Expect:** ingest `ready`, no findings, clean ads on any ground. Its `logo_reverse`
note names `#6B7280`, so the reverse-logo switch point comes from the brand rather
than from our constant.

## 2 · atlas-tooling — unconventional, recoverable

Everything is written differently rather than missing:

| | |
|---|---|
| Section titled `## Colours`, not `## Palette` | must still be found |
| Colours as `rgb(30, 41, 59)` | must still be read |
| Sizes in `rem`, and prose says `52px` while the table says `3.25rem` | prose governs |
| Names `Satoshi Display`, ships two `satoshi` weights | substitution, recorded |
| Token cache disagrees on primary, accent, h1 and radius | `DESIGN.md` wins, four findings |
| A `logo_lockup` and no `logo_reverse` | dark grounds fall to the mark |

**Expect:** ingest `ready`, six findings, ads that work. This is the one that found two
real bugs in our loader — see *What these kits already fixed* below.

## 3 · meridian-health — severely degraded

| | |
|---|---|
| Palette in Pantone | unreadable, and there is no correct conversion |
| No `fonts/` directory at all | browser fallback is not the brand |
| Names `Founders Grotesk`, ships nothing | unresolvable, not substitutable |
| Manifest lists a reverse logo and a lockup; neither file exists | a path is not an asset |
| Type scale says `large`, `medium`, `regular` | no number to use |

**Expect:** ingest `ready` with **nine findings**, and a logo that is refused on dark
grounds rather than swapped for something that will not read. Ads are possible and will
be visibly compromised. That is the correct outcome, not a failure.

## 4 · vantage-partners — should be refused

No `DESIGN.md`. A manifest, one logo, a token cache, and an asset tagged
`bk-northwind-2026` that was filed here by mistake.

**Expect:** ingest **blocked**, with `no-design-doc`. The misfiled asset must belong to
Northwind and be invisible to Vantage — both the row and the bytes.

---

## What these kits already fixed

Writing them found four real defects, which is the point of writing them:

1. **A kit with no `DESIGN.md` was invisible rather than refused.** Discovery required
   the file, so the blocker ingest already had for this case could never fire. A
   customer with a bad upload would have seen nothing and no explanation.
2. **`## Colours` produced an empty palette, silently.** No finding, and the render fell
   back to black and white looking entirely deliberate. Headings now accept synonyms,
   and an unreadable palette is reported.
3. **`rgb(30, 41, 59)` was truncated to `rgb`** by the code that strips a trailing note
   like `#1B3A5C (navy)`. A note is separated by whitespace; a function's bracket is
   not.
4. **`Typography` was not read as `Type`**, so a kit naming its fonts under that heading
   appeared to name none.

## A note on the font files

The `.ttf` files are copies of the packet's own faces, renamed. Generating real
typefaces is not feasible here, and the pipeline identifies a family from the filename,
so a renamed file exercises every path that matters — substitution, weight fallback,
`@font-face` loading, and the post-render check that the browser really used a brand
face. They are placeholders for the binary only.
