-- 0005 · the role a run actually connects as
--
-- The run token carries `"role": "sandbox_run"`, and PostgREST switches into
-- whatever that claim names. So the role has to exist and be reachable, or every
-- policy in 0002 is guarding a door nobody walks through.
--
-- Grants and RLS are two independent gates, and both are used deliberately:
--
--   RLS answers "which rows?"      — scoped to one revision, one kit.
--   Grants answer "which verbs?"   — no UPDATE or DELETE on artifacts at all.
--
-- Append-only from inside a box is therefore enforced twice, by the absence of a
-- policy and by the absence of a grant. Either alone would be enough; both means
-- a future policy added carelessly still cannot make a run able to erase its own
-- record.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sandbox_run') then
    create role sandbox_run nologin noinherit;
  end if;
end
$$;

grant usage on schema public to sandbox_run;
grant usage on schema app to sandbox_run;

-- The claim readers. A policy calls these on every row, so a run must be able to
-- execute them; they expose only what is already in its own token.
grant execute on function app.claim(text)        to sandbox_run;
grant execute on function app.run_revision()     to sandbox_run;
grant execute on function app.run_id()           to sandbox_run;
grant execute on function app.run_kit()          to sandbox_run;
grant execute on function app.is_run()           to sandbox_run;
grant execute on function app.run_work_prefix()  to sandbox_run;
grant execute on function app.run_brains_prefix() to sandbox_run;

-- Read. RLS narrows every one of these to the run's own revision or kit.
grant select on
  brand_kits, brand_assets, brand_fonts,
  requests, request_canvases, revisions,
  messages, runs, artifacts, findings
to sandbox_run;

-- Write, and only these three. The agent saves its own work, adds to the chat
-- thread, and reports what it could not do.
grant insert on messages, artifacts, findings to sandbox_run;

-- Status only. RLS pins these to the run's own row and its own revision.
grant update on runs, revisions to sandbox_run;

-- Never granted, deliberately:
--   update/delete on artifacts   · a run cannot rewrite or erase its own record
--   insert/update on brand_*     · a run cannot stage or alter a brand asset
--   delete on anything           · retention belongs to the backend
--   truncate, references         · no

-- Storage. Objects are governed by the policies in 0003; these are the verbs.
grant usage on schema storage to sandbox_run;
grant select, insert on storage.objects to sandbox_run;
grant select on storage.buckets to sandbox_run;

-- Let the connection pooler assume the role. Guarded because a local Postgres
-- used for tests has no `authenticator`.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant sandbox_run to authenticator';
  end if;
end
$$;

-- Future tables must opt in explicitly. Without this a table added later would
-- inherit nothing, which is the safe direction — but say so, because "it works
-- because we forgot to grant it" is not a guarantee.
alter default privileges in schema public revoke all on tables from sandbox_run;
