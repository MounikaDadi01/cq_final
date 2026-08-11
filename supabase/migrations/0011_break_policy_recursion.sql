-- 0011 · break the policy recursion
--
-- Found by a test, and it would have been found by the first UI query otherwise:
--
--   error: infinite recursion detected in policy for relation "requests"
--
-- The cause is structural rather than a typo. A policy on `revisions` subqueried
-- `requests`; a policy on `requests` subqueried `revisions`. Each subquery is itself
-- filtered by the other table's policies, so the two policies call each other and
-- Postgres stops the cycle by refusing the whole query.
--
-- It only appeared once BOTH the sandbox policies and the human policies existed,
-- because a cycle needs two directions. That is worth noting: neither migration was
-- wrong on its own, and testing them separately would have found nothing.
--
-- The fix is to stop policies from reading policed tables. Every cross-table lookup
-- moves into a `security definer` function, which resolves the tenancy question once,
-- outside RLS, and returns ids. Policies then compare against a list instead of
-- running a policed query — no cycle is possible because no policy reads a table
-- that has policies.
--
-- These functions are the tenancy boundary now, so they are deliberately small,
-- read-only, and return nothing but ids.

-- ---------------------------------------------------------------------------
-- Resolvers
-- ---------------------------------------------------------------------------

/** The request behind the run's revision. */
create or replace function app.run_request() returns uuid
language sql stable security definer set search_path = public as $$
  select request_id from revisions where id = app.run_revision();
$$;

/** Threads on the run's request. */
create or replace function app.run_threads() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from comment_threads where request_id = app.run_request();
$$;

/** Every request belonging to the session customer. */
create or replace function app.user_requests() returns setof uuid
language sql stable security definer set search_path = public as $$
  select q.id
    from requests q
    join brand_kits k on k.id = q.kit_id
   where k.customer_id = app.user_customer();
$$;

/** Every revision belonging to the session customer. */
create or replace function app.user_revisions() returns setof uuid
language sql stable security definer set search_path = public as $$
  select r.id
    from revisions r
    join requests q on q.id = r.request_id
    join brand_kits k on k.id = q.kit_id
   where k.customer_id = app.user_customer();
$$;

/** Every comment thread belonging to the session customer. */
create or replace function app.user_threads() returns setof uuid
language sql stable security definer set search_path = public as $$
  select t.id
    from comment_threads t
    join requests q on q.id = t.request_id
    join brand_kits k on k.id = q.kit_id
   where k.customer_id = app.user_customer();
$$;

grant execute on function app.run_request() to sandbox_run, sandbox_deploy;
grant execute on function app.run_threads() to sandbox_run;
grant execute on function app.user_requests() to app_user;
grant execute on function app.user_revisions() to app_user;
grant execute on function app.user_threads() to app_user;

comment on function app.user_requests() is
  'Tenancy boundary. security definer so a policy never has to read a policed table, '
  'which is what created a recursive cycle between requests and revisions.';

-- ---------------------------------------------------------------------------
-- Sandbox run policies, rewritten against the resolvers
-- ---------------------------------------------------------------------------

drop policy requests_run_select on requests;
create policy requests_run_select on requests
  for select using (app.is_run() and id = app.run_request());

drop policy request_canvases_run_select on request_canvases;
create policy request_canvases_run_select on request_canvases
  for select using (app.is_run() and request_id = app.run_request());

drop policy comment_threads_run_select on comment_threads;
create policy comment_threads_run_select on comment_threads
  for select using (app.is_run() and request_id = app.run_request());

drop policy comment_messages_run_select on comment_messages;
create policy comment_messages_run_select on comment_messages
  for select using (app.is_run() and thread_id in (select app.run_threads()));

drop policy comment_messages_run_insert on comment_messages;
create policy comment_messages_run_insert on comment_messages
  for insert with check (
    app.is_run()
    and author = 'agent'
    and run_id = app.run_id()
    and thread_id in (select app.run_threads())
  );

drop policy comment_attachments_run_select on comment_attachments;
create policy comment_attachments_run_select on comment_attachments
  for select using (
    app.is_run()
    and message_id in (
      select m.id from comment_messages m where m.thread_id in (select app.run_threads())
    )
  );

-- ---------------------------------------------------------------------------
-- Deploy policies
-- ---------------------------------------------------------------------------

drop policy requests_deploy_select on requests;
create policy requests_deploy_select on requests
  for select using (app.is_deploy() and id = app.run_request());

drop policy request_canvases_deploy_select on request_canvases;
create policy request_canvases_deploy_select on request_canvases
  for select using (app.is_deploy() and request_id = app.run_request());

-- ---------------------------------------------------------------------------
-- Human policies
-- ---------------------------------------------------------------------------

drop policy request_canvases_user_select on request_canvases;
create policy request_canvases_user_select on request_canvases
  for select using (app.is_app_user() and request_id in (select app.user_requests()));

drop policy revisions_user_select on revisions;
create policy revisions_user_select on revisions
  for select using (app.is_app_user() and request_id in (select app.user_requests()));

drop policy runs_user_select on runs;
create policy runs_user_select on runs
  for select using (app.is_app_user() and revision_id in (select app.user_revisions()));

drop policy artifacts_user_select on artifacts;
create policy artifacts_user_select on artifacts
  for select using (app.is_app_user() and revision_id in (select app.user_revisions()));

drop policy findings_user_select on findings;
create policy findings_user_select on findings
  for select using (
    app.is_app_user()
    and (kit_id in (select app.user_kits()) or revision_id in (select app.user_revisions()))
  );

drop policy messages_user_select on messages;
create policy messages_user_select on messages
  for select using (app.is_app_user() and revision_id in (select app.user_revisions()));

drop policy comment_threads_user_select on comment_threads;
create policy comment_threads_user_select on comment_threads
  for select using (app.is_app_user() and request_id in (select app.user_requests()));

drop policy comment_messages_user_select on comment_messages;
create policy comment_messages_user_select on comment_messages
  for select using (app.is_app_user() and thread_id in (select app.user_threads()));

drop policy comment_attachments_user_select on comment_attachments;
create policy comment_attachments_user_select on comment_attachments
  for select using (
    app.is_app_user()
    and message_id in (
      select m.id from comment_messages m where m.thread_id in (select app.user_threads())
    )
  );

drop policy request_canvases_user_insert on request_canvases;
create policy request_canvases_user_insert on request_canvases
  for insert with check (app.is_app_user() and request_id in (select app.user_requests()));

drop policy revisions_user_insert on revisions;
create policy revisions_user_insert on revisions
  for insert with check (app.is_app_user() and request_id in (select app.user_requests()));

drop policy revisions_user_update on revisions;
create policy revisions_user_update on revisions
  for update using (app.is_app_user() and request_id in (select app.user_requests()))
  with check (request_id in (select app.user_requests()));

drop policy comment_threads_user_insert on comment_threads;
create policy comment_threads_user_insert on comment_threads
  for insert with check (app.is_app_user() and request_id in (select app.user_requests()));

drop policy comment_threads_user_update on comment_threads;
create policy comment_threads_user_update on comment_threads
  for update using (app.is_app_user() and request_id in (select app.user_requests()))
  with check (request_id in (select app.user_requests()));

drop policy comment_messages_user_insert on comment_messages;
create policy comment_messages_user_insert on comment_messages
  for insert with check (
    app.is_app_user() and author = 'user' and thread_id in (select app.user_threads())
  );

-- ---------------------------------------------------------------------------
-- Storage, same treatment
-- ---------------------------------------------------------------------------

create or replace function app.user_request_prefixes() returns setof text
language sql stable security definer set search_path = public as $$
  select id::text from app.user_requests() as id;
$$;

grant execute on function app.user_request_prefixes() to app_user;
