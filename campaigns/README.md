# Campaigns — local test fixtures only

**Nothing in here is product data, and nothing in here ships.** These are invented
campaigns used to exercise the pipeline on this machine, which is what the brief
asks for:

> Make the campaign up — the Long Island Railroad, whatever.

They are committed so the submission shows what was actually tested, not because
the running system reads them. In the real system a campaign arrives from an
operator through the composer and lands in Postgres; these files stand in for that
while the composer does not exist yet.

## What each one is for

| File | Exercises |
|---|---|
| `lirr-east-side-access.json` | Kahua, **all four canvases** — so the 728×90 finding is produced by a real request rather than a unit test |
| `emplifi-shoppable-video.json` | Emplifi, three canvases, **one attached inspiration** — the only path on which an inspiration is consulted |
| `kahua-federal-edit.json` | The **edit** path: a parent revision, operator messages, and one canvas |

Two brands on purpose. *"A pipeline that only works for Kahua isn't a pipeline."*

## Adding one

Drop a JSON file in here and it is picked up — campaigns are discovered, not
registered. `npm test` inside `eval/` then validates it before anything can spend
money on a plate:

- the pinned `brand_kit_id` resolves to an ingested brand, and is never guessed
  from a name
- every `inspirations` entry is a real filename, because a typo would silently
  mean "no reference attached"
- a headline and a CTA exist, and whitespace does not count as copy
- each canvas is checked against the image model's envelope — an impossible one is
  a **finding**, not a failure, so the other canvases still ship

`plate_direction` is the human's intent for the imagery: composition, subject,
lighting, palette, negative space. The agent expands it into a full prompt and adds
the prohibitions — no words, letters, logos, badges or UI text.
