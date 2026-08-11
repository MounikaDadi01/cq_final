-- 0006 · the deployment role
--
-- Deployment is a different job from generation with a different blast radius, so
-- it gets its own role rather than reusing `sandbox_run`.
--
-- The asymmetry is deliberate and runs both ways:
--
--   a generation box can write render artifacts and cannot write a recording
--   a deploy box can write a recording and cannot write render artifacts
--
-- Sharing one role would leave the separation existing only in whichever code
-- path happened to create the box. That holds right up until someone adds a
-- second caller. Deploy is also the brief's one automatic disqualifier, which is
-- reason enough for it to carry the narrower credential.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sandbox_deploy') then
    create role sandbox_deploy nologin noinherit;
  end if;
end
$$;

grant usage on schema public to sandbox_deploy;
grant usage on schema app to sandbox_deploy;

grant execute on function app.claim(text)         to sandbox_deploy;
grant execute on function app.run_revision()      to sandbox_deploy;
grant execute on function app.run_id()            to sandbox_deploy;
grant execute on function app.run_kit()           to sandbox_deploy;
grant execute on function app.run_work_prefix()   to sandbox_deploy;

-- ---------------------------------------------------------------------------
-- What a deploy is
--
-- `app.is_deploy()` mirrors `app.is_run()`: a token missing a claim is not a
-- weaker deploy, it is not a deploy. Kept as a separate function rather than a
-- parameter so a policy reads as the sentence it enforces.
-- ---------------------------------------------------------------------------

create or replace function app.is_deploy() returns boolean
language sql stable as $$
  select app.claim('role') = 'sandbox_deploy'
     and app.run_revision() is not null
     and app.run_id() is not null;
$$;

grant execute on function app.is_deploy() to sandbox_deploy;
grant execute on function app.is_deploy() to sandbox_run;

-- ---------------------------------------------------------------------------
-- Reads. A deploy box needs to know what it is publishing, so it reads the
-- revision's artifacts — and nothing about any other revision.
-- ---------------------------------------------------------------------------

grant select on requests, request_canvases, revisions, artifacts, runs, brand_kits to sandbox_deploy;

create policy revisions_deploy_select on revisions
  for select using (app.is_deploy() and id = app.run_revision());

create policy requests_deploy_select on requests
  for select using (
    app.is_deploy()
    and id in (select request_id from revisions where id = app.run_revision())
  );

create policy request_canvases_deploy_select on request_canvases
  for select using (
    app.is_deploy()
    and request_id in (select request_id from revisions where id = app.run_revision())
  );

create policy brand_kits_deploy_select on brand_kits
  for select using (app.is_deploy() and id = app.run_kit());

-- Read every artifact of its own revision. This is the point of a deploy box:
-- it publishes what generation produced.
create policy artifacts_deploy_select on artifacts
  for select using (app.is_deploy() and revision_id = app.run_revision());

create policy runs_deploy_select on runs
  for select using (app.is_deploy() and id = app.run_id());

-- ---------------------------------------------------------------------------
-- Writes. Exactly one artifact role, and its own run row.
--
-- The `role = 'recording'` predicate is the whole separation. Without it a deploy
-- token could insert a row claiming to be a render, and the record of what
-- generation produced would no longer be trustworthy — a deploy box could
-- fabricate the very thing it is supposed to be publishing.
-- ---------------------------------------------------------------------------

grant insert on artifacts, findings to sandbox_deploy;
grant update on runs to sandbox_deploy;

create policy artifacts_deploy_insert on artifacts
  for insert with check (
    app.is_deploy()
    and revision_id = app.run_revision()
    and role = 'recording'
  );

create policy findings_deploy_insert on findings
  for insert with check (app.is_deploy() and revision_id = app.run_revision());

create policy findings_deploy_select on findings
  for select using (app.is_deploy() and revision_id = app.run_revision());

create policy runs_deploy_update on runs
  for update using (app.is_deploy() and id = app.run_id())
  with check (id = app.run_id() and revision_id = app.run_revision());

-- ---------------------------------------------------------------------------
-- Storage
--
-- A deploy box reads the tree it is publishing and writes only its recording,
-- under a reserved subdirectory of the same revision prefix. Same prefix so the
-- one-tree-in-one-tree-out property survives; reserved subdirectory so a
-- recording can never overwrite a render.
-- ---------------------------------------------------------------------------

grant usage on schema storage to sandbox_deploy;
grant select, insert on storage.objects to sandbox_deploy;
grant select on storage.buckets to sandbox_deploy;

create policy work_deploy_read on storage.objects
  for select using (
    bucket_id = 'work'
    and app.is_deploy()
    and app.run_work_prefix() is not null
    and name like app.run_work_prefix() || '/%'
  );

create policy work_deploy_write on storage.objects
  for insert with check (
    bucket_id = 'work'
    and app.is_deploy()
    and app.run_work_prefix() is not null
    and name like app.run_work_prefix() || '/deploy/%'
  );

-- Brand assets stay out of reach. A deploy box publishes finished artifacts and
-- has no reason to open a logo, so it is granted nothing on brand_assets or
-- brand_fonts and cannot read the brains bucket.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant sandbox_deploy to authenticator';
  end if;
end
$$;

alter default privileges in schema public revoke all on tables from sandbox_deploy;

-- ---------------------------------------------------------------------------
-- Deliberately absent for sandbox_deploy
--
--   insert of any artifact role but `recording`
--   update or delete on artifacts
--   any grant at all on brand_assets, brand_fonts, messages
--   write to the brains bucket, or to `work/<prefix>/` outside `deploy/`
-- ---------------------------------------------------------------------------
