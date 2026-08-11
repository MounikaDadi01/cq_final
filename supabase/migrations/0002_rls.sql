-- 0002 · row-level security
--
-- RLS is the isolation. Not a credential wrapper around the data — a rule where
-- the data lives, which is why the cross-tenant test is a SQL assertion rather
-- than a green tick from something we wrote ourselves.
--
-- Two rules govern everything below:
--
--   1. Every table has RLS enabled. A table with no policy is unreachable, not
--      open. Deny-by-default only holds if it is switched on everywhere, so
--      0004 asserts it against pg_class rather than trusting this file.
--
--   2. `service_role` bypasses RLS entirely and therefore must never enter a
--      sandbox. Nothing here can defend against that; it is checked before a box
--      is created.
--
-- The run JWT:
--   { "role": "sandbox_run", "run_id": "…", "revision_id": "…", "brand_kit_id": "bk-…" }

-- ---------------------------------------------------------------------------
-- Claim readers
--
-- Kept as functions so a policy reads like the sentence it enforces, and so a
-- claim's absence is null rather than an exception. A null claim can satisfy no
-- comparison below, which is the safe direction.
-- ---------------------------------------------------------------------------

create schema if not exists app;

create or replace function app.claim(name text) returns text
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> name, '');
$$;

create or replace function app.run_revision() returns uuid
language sql stable as $$
  select nullif(app.claim('revision_id'), '')::uuid;
$$;

create or replace function app.run_id() returns uuid
language sql stable as $$
  select nullif(app.claim('run_id'), '')::uuid;
$$;

create or replace function app.run_kit() returns text
language sql stable as $$
  select app.claim('brand_kit_id');
$$;

create or replace function app.is_run() returns boolean
language sql stable as $$
  select app.claim('role') = 'sandbox_run'
     and app.run_revision() is not null
     and app.run_id() is not null;
$$;

comment on function app.is_run() is
  'True only for a fully formed run token. A token missing a claim is not a '
  'weaker run, it is not a run.';

-- ---------------------------------------------------------------------------
-- Enable everywhere, before any policy exists
-- ---------------------------------------------------------------------------

alter table brand_kits       enable row level security;
alter table brand_assets     enable row level security;
alter table brand_fonts      enable row level security;
alter table requests         enable row level security;
alter table request_canvases enable row level security;
alter table revisions        enable row level security;
alter table messages         enable row level security;
alter table runs             enable row level security;
alter table artifacts        enable row level security;
alter table findings         enable row level security;

-- Force it for table owners too, so a privileged connection cannot quietly
-- sidestep the policies that the whole isolation argument rests on.
alter table brand_assets     force row level security;
alter table brand_fonts      force row level security;
alter table artifacts        force row level security;
alter table findings         force row level security;

-- ---------------------------------------------------------------------------
-- Brands · read-only to a run, and only its own kit
-- ---------------------------------------------------------------------------

create policy brand_kits_run_select on brand_kits
  for select using (app.is_run() and id = app.run_kit());

-- The cross-tenant leak, closed at the database.
--
-- An asset carries the kit that OWNS it. A misfiled asset therefore keeps the
-- owning kit's id while sitting in another kit's folder, and a run holding the
-- other kit's claim simply cannot see the row. Nothing filters it out; it was
-- never in the result set.
--
-- Note this reads kit_id and never found_in_kit_id. Filtering on where the file
-- happens to sit is exactly the mistake the packet is testing for.
create policy brand_assets_run_select on brand_assets
  for select using (
    app.is_run()
    and kit_id = app.run_kit()
    and available
  );

create policy brand_fonts_run_select on brand_fonts
  for select using (app.is_run() and kit_id = app.run_kit());

-- ---------------------------------------------------------------------------
-- Work · scoped to the one revision the run was minted for
-- ---------------------------------------------------------------------------

create policy revisions_run_select on revisions
  for select using (app.is_run() and id = app.run_revision());

-- A run may mark its own revision partial or complete, and nothing else about it.
create policy revisions_run_update on revisions
  for update using (app.is_run() and id = app.run_revision())
  with check (id = app.run_revision());

create policy requests_run_select on requests
  for select using (
    app.is_run()
    and id in (select request_id from revisions where id = app.run_revision())
  );

create policy request_canvases_run_select on request_canvases
  for select using (
    app.is_run()
    and request_id in (select request_id from revisions where id = app.run_revision())
  );

-- Chat is how a human iterates, so a run both reads the thread and adds to it.
create policy messages_run_select on messages
  for select using (app.is_run() and revision_id = app.run_revision());

create policy messages_run_insert on messages
  for insert with check (
    app.is_run() and revision_id = app.run_revision() and role = 'agent'
  );

create policy runs_run_select on runs
  for select using (app.is_run() and id = app.run_id());

-- Its own row, and only its own. The revision is re-checked so a token cannot
-- update a run belonging to a different revision even if the ids were confused.
create policy runs_run_update on runs
  for update using (app.is_run() and id = app.run_id())
  with check (id = app.run_id() and revision_id = app.run_revision());

-- The agent saves its own work. This INSERT is the mechanism, which is why the
-- policy is scoped to one revision and there is no UPDATE or DELETE: a run may
-- add to the record and can neither rewrite nor erase it.
create policy artifacts_run_insert on artifacts
  for insert with check (app.is_run() and revision_id = app.run_revision());

create policy artifacts_run_select on artifacts
  for select using (app.is_run() and revision_id = app.run_revision());

-- A run reports what it could not do. Reporting must never be the thing that
-- fails, so this is the most permissive policy here — still bounded to the one
-- revision.
create policy findings_run_insert on findings
  for insert with check (app.is_run() and revision_id = app.run_revision());

create policy findings_run_select on findings
  for select using (app.is_run() and revision_id = app.run_revision());

-- ---------------------------------------------------------------------------
-- Deliberately absent
--
-- brand_kits    · no INSERT/UPDATE/DELETE for a run. Ingest is the backend's job.
-- brand_assets  · no write of any kind. A run cannot stage an asset.
-- brand_fonts   · same.
-- requests      · a run does not author the request it is executing.
-- artifacts     · no UPDATE, no DELETE. Append-only from inside a box.
-- everything else for any other role · no policy, therefore no access.
-- ---------------------------------------------------------------------------
