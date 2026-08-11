---
name: deploy-campaign
description: Push finished, approved ad artifacts into a marketing tool by driving its interface. Use only for deployment of an already-completed revision. Never use to create, edit or regenerate creative.
---

# Deploy a campaign

Take artifacts that already exist and put them into a marketing tool by driving
its interface as a person would. Produce evidence that it happened.

This skill does not make creative. If something is missing, wrong, or off-brand,
that is a finding to report — not a thing to fix here. `design-generation` makes
creative; this skill moves it.

## Invariants

1. **Upload only the bytes you were given.** `hydration.json` lists exactly which
   artifacts to publish, with signed URLs. Nothing else is publishable, and nothing
   is regenerated, re-rendered, re-cropped or re-encoded on the way.
2. **The recording is not optional.** A deploy with no recording did not happen as
   far as this system is concerned. Start recording before the first navigation and
   save it before reporting completion.
3. **Never invent a value.** Every value the form needs is in `hydration.json` under
   `target.fields`, resolved before the box opened — including the tool's single body
   field, which is composed there from the approved copy. Use those verbatim.
   `campaign.copy` is context for understanding the ad, **not** a source to assemble a
   field out of: one run stopped rather than guess how four parts of copy became one
   Primary text, which was right, and another guessed and published "testing the
   rendering" to a live account. If the form asks for something `target.fields` does
   not carry, stop and report it.
4. **Never publish past a blocker.** If the tool reports an error, a rejected
   upload, or a validation failure, stop. A half-created campaign is worse than
   none, because someone has to find it before they can undo it.
5. **Credentials come from the environment, by name.** They are never in
   `hydration.json`, never logged, and never typed into a page that is not the tool
   you were sent to.
6. **One target.** The entry URL in `hydration.json` is the only host to visit.

## Order

1. `hydration.json` — what to publish, where, and which env vars hold credentials.
2. This skill.
3. The signed URLs — download the artifacts to disk first, so an expiring URL
   cannot fail halfway through a form.
4. The tool.

## Doing it

**Before anything.** Confirm every artifact downloads and its byte count matches
what `hydration.json` states. An artifact that will not download is a blocker
before you have touched the tool, which is the cheapest moment to stop.

**Start the recording.** A browser context with video capture, opened before the
first navigation. If recording cannot start, that is a blocker.

**Sign in.** Read credentials from the named environment variables.

**Drive the interface.** Work from what is on screen. Read the page, find the
control that does what you need, and use it. Prefer visible, labelled controls over
anything you have to guess at.

Do not rely on a fixed sequence of selectors — a recorded click path is a
description of one past visit, not a rule about this one. Interfaces change, and a
script that assumes last week's DOM fails silently by clicking the wrong thing.

**One ad per creative.** The hydration lists every canvas being published. The tool's
creative step takes a single image, so a campaign with three canvases is **three ads**,
not one ad with three files attached. Do not try to attach several creatives to one ad —
that is the `MULTI_ARTIFACT_UNSUPPORTED` case, and stopping was right.

Loop instead. For each creative in `publish`:

1. Start a new ad from the beginning of the tool's own flow.
2. Give it a name that distinguishes it from its siblings — the ad name plus the canvas,
   so `Capital projects (square)` and `Capital projects (landscape)` are told apart in
   the list. Two ads with the same name are indistinguishable to the person who has to
   audit them later.
3. Use the same campaign, objective, audience, placements, budget and call to action for
   every one. Only the creative and the name differ.
4. Upload that canvas's file, publish, and confirm it in the list before moving on.

Confirm each one as you go rather than all at the end. A tool that silently drops the
third upload looks identical to one that took it, until you look.

**A blocker stops that ad, not the run.** Report it and start the next canvas from the
beginning of the flow. Nothing about a rejected portrait makes publishing square unsafe
— they are separate ads, and the size that never went live is the one nobody finds out
about. Only two things end everything: sign-in failing, and the tool not being what the
entry URL implied, because those affect every ad equally.

Then report once, at the end, after the last canvas — whatever happened to the ones
before it. A run that ends without reporting is recorded as if nothing shipped, which
is a worse lie than a partial outcome.

Publishing some and not others is a partial outcome, and it is reported as such: the
outcome is `published` only when every canvas in `publish` has been confirmed in the
list. Some-succeeded is `unverified`, with the names of the ones that made it.

**Verify before claiming.** After creating the campaign, read back what the tool
shows: the campaign exists, the creative is attached, the dimensions are what you
uploaded. Report what you actually saw.

**Then go back to the list and find it.** The confirmation screen is the tool telling
you it worked; the list is the tool showing you. Those are different claims, and only
the second one survives someone asking "where is it, then?"

Concretely, and in this order:

1. Wait a few seconds on the confirmation screen. A success toast usually clears on a
   timer, and its disappearance is the signal that the write has settled rather than
   still being in flight.
2. Navigate back to the list — Ads Manager, or whatever the tool calls it. Navigate;
   do not trust a cached render or your memory of what was there.
3. Find your ad by the exact name you gave it, and check the row looks right: the
   campaign you attached it to, and a creation date of today rather than one of the
   fixture rows.
4. Only then call `record_outcome`.

Call `confirm_in_list` to do this. An outcome of `published` is **downgraded to
unverified** if that call never found the ad, so skipping it does not get you a better
result — it gets you a worse one.

This also fixes the order of the recording. The video used to end on the confirmation
page, one screen before the only screen that proves anything. The list must be on
camera before the context closes.

**Save.** Close the browser context so the video flushes, then `save_work`. In that
order — a recording still in memory when the box dies is a recording that never
existed.

## Reporting

Write `deploy/RESULT.json`:

- what was published, with the byte count and digest of each artifact
- the campaign or entity id the tool assigned, if it gave one
- what you read back to verify, in the tool's own words
- every field you could not fill, and why
- anything you stopped for

Then `save_work --final`.

## When to stop rather than continue

- an artifact will not download, or its size disagrees with the manifest
- recording will not start
- sign-in fails, or lands somewhere unexpected
- the tool rejects an upload, or reports a validation error

A control that is merely *disabled* is not yet one of these. `act` waits for it and
then reports what is blocking the form — usually a required field still empty, which
is something you can fix. Read that before concluding you are stuck: stopping costs
every canvas you had not reached yet, and a greyed-out button a second after an upload
is the tool working, not the tool refusing.
- a required field has no value in `hydration.json`
- the interface is not what the entry URL implied

In every case: report it, save what exists, and exit. Nothing here is urgent enough
to justify guessing.
