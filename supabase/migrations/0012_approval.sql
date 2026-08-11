-- 0012 · approval is not a run state
--
-- The first attempt set `revisions.status = 'approved'`, which the check constraint
-- correctly refused. The constraint was right and the idea was wrong: `status`
-- describes what happened to the *run* — draft, running, partial, complete, failed —
-- and approval is a human judgement about a revision that has already finished.
--
-- Squeezing both into one column would make "complete" and "approved" mutually
-- exclusive, when in fact every approved revision must first be complete.

alter table revisions
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by text;

-- Only a finished revision can be approved. A half-saved revision that could be
-- marked publishable is a deploy waiting to publish something incomplete.
alter table revisions
  drop constraint if exists revisions_approved_only_when_complete;
alter table revisions
  add constraint revisions_approved_only_when_complete
  check (approved_at is null or status in ('complete', 'deleted'));

comment on column revisions.approved_at is
  'Set by a person, never by a run. A run has no update grant that could reach it: '
  'its policy allows status changes only, and approving your own work is not a '
  'judgement.';

create index if not exists revisions_approved_idx on revisions (request_id) where approved_at is not null;
