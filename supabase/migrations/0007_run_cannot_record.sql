-- 0007 · close the other direction
--
-- 0006 stopped a deploy box from writing renders. Writing the tests for it made
-- the gap obvious: nothing stopped a *generation* box from writing a `recording`.
--
-- That matters because a deploy recording is the evidence a deploy happened, and
-- the brief treats deploying as the one automatic disqualifier. If a generation
-- box can insert one, the record stops meaning "a deploy box did this" and starts
-- meaning "something did this" — which is not evidence of anything.
--
-- A separate migration rather than an edit to 0006, because 0006 is already
-- applied. Numbered files are supposed to show how the shape was reached, and
-- "the asymmetry was noticed while testing it" is part of how it was reached.

drop policy artifacts_run_insert on artifacts;

create policy artifacts_run_insert on artifacts
  for insert with check (
    app.is_run()
    and revision_id = app.run_revision()
    -- Every role a generation box legitimately produces, named positively.
    -- A denylist would silently admit any role added later; this refuses
    -- anything not yet thought about, which is the safe direction.
    and role in ('render', 'plate', 'html', 'asset', 'result', 'other')
  );

comment on policy artifacts_run_insert on artifacts is
  'Generation writes everything but `recording`. Deploy writes only `recording`. '
  'Neither can produce the other kind, so the artifact role is trustworthy '
  'evidence of which box made it.';
