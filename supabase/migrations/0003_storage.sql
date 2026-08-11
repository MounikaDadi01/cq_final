-- 0003 · buckets and object policies
--
-- Two private buckets. The storage key IS the relative path under a prefix, so
-- one tree goes in and one tree comes out and nothing reconciles a flat key
-- space against a nested directory.
--
--   brains/<kit-id>/...                    read-only to a run, own kit only
--   work/<request-id>/rev-<n>/...          the run's own revision, read and write
--
-- Versioning on `work` so a superseded attempt's bytes survive without us
-- maintaining a version graph.

insert into storage.buckets (id, name, public, file_size_limit)
values
  ('brains', 'brains', false, 52428800),
  ('work',   'work',   false, 52428800)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Prefixes, derived rather than passed
--
-- The run token carries revision_id, not the request id or the revision number,
-- so the prefix a run may touch is looked up rather than trusted from the
-- caller. A token cannot widen its own reach by asserting a different path.
-- ---------------------------------------------------------------------------

create or replace function app.run_work_prefix() returns text
language sql stable security definer set search_path = public as $$
  select rev.request_id::text || '/rev-' || rev.n::text
    from revisions rev
    join requests r on r.id = rev.request_id
   where rev.id = app.run_revision();
$$;

comment on function app.run_work_prefix() is
  'security definer because a run cannot select the rows this join needs until '
  'its own policies apply; the function returns only the prefix, never a row.';

create or replace function app.run_brains_prefix() returns text
language sql stable as $$
  select app.run_kit();
$$;

-- ---------------------------------------------------------------------------
-- brains · read-only, own kit
-- ---------------------------------------------------------------------------

create policy brains_run_read on storage.objects
  for select using (
    bucket_id = 'brains'
    and app.is_run()
    and app.run_brains_prefix() is not null
    -- Compared as a whole path segment. A prefix test alone would let a kit id
    -- that merely starts with another's reach across.
    and (storage.foldername(name))[1] = app.run_brains_prefix()
  );

-- ---------------------------------------------------------------------------
-- work · the run's own revision, read and write
--
-- INSERT and SELECT only. No UPDATE, no DELETE: a run adds to the record of its
-- revision and can neither overwrite nor remove what is already saved. Retention
-- and deletion are the backend's, so a box cannot destroy evidence of itself.
-- ---------------------------------------------------------------------------

create policy work_run_read on storage.objects
  for select using (
    bucket_id = 'work'
    and app.is_run()
    and app.run_work_prefix() is not null
    and name like app.run_work_prefix() || '/%'
  );

create policy work_run_write on storage.objects
  for insert with check (
    bucket_id = 'work'
    and app.is_run()
    and app.run_work_prefix() is not null
    and name like app.run_work_prefix() || '/%'
  );

-- ---------------------------------------------------------------------------
-- Deliberately absent
--
-- No policy on any other bucket, so a run reaches nothing else.
-- No UPDATE or DELETE on either bucket for a run.
-- ---------------------------------------------------------------------------
