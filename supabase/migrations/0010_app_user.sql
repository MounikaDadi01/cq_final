-- 0010 · the human side, scoped to one customer
--
-- Until now every policy served `sandbox_run` or `sandbox_deploy`. A browser holds
-- neither, so the only way a UI could read anything was with `service_role` — which
-- bypasses RLS entirely. That would put "customers never mix" in the hands of
-- whichever frontend query someone wrote last, which is exactly the wrong place for
-- it.
--
-- So the UI gets its own role, and the isolation lives in the database:
--
--   { "role": "app_user", "customer_id": "…" }
--
-- Every read below is filtered to that customer, reached by joining through the kit.
-- The customer id is the only thing the token asserts, and nothing in the UI can
-- widen it — a mistaken query returns zero rows rather than someone else's ad.
--
-- Note what is *not* here: no policy lets `app_user` see another customer's kit, and
-- no policy lets it write a brand asset, an artifact, or a run row. A person asks
-- for work; the agent produces it. Those are different credentials on purpose.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user nologin noinherit;
  end if;
end
$$;

grant usage on schema public to app_user;
grant usage on schema app to app_user;

create or replace function app.user_customer() returns text
language sql stable as $$
  select app.claim('customer_id');
$$;

/**
 * True only for a fully formed app-user session.
 *
 * Same shape as `app.is_run()`, and same reasoning: the claimed role and the
 * connected role must agree, so a token cannot borrow a different role's policies by
 * presenting a different claim. A session missing `customer_id` is not a
 * less-privileged user — it is not a user.
 */
create or replace function app.is_app_user() returns boolean
language sql stable as $$
  select app.claim('role') = 'app_user'
     and current_role = 'app_user'
     and nullif(app.claim('customer_id'), '') is not null;
$$;

grant execute on function app.claim(text) to app_user;
grant execute on function app.user_customer() to app_user;
grant execute on function app.is_app_user() to app_user;

/**
 * The kits this session may touch, as a single source of truth.
 *
 * Every policy below routes through here rather than repeating the join. One place
 * to be wrong is better than eleven, and a reviewer can check the tenancy rule by
 * reading one function.
 */
create or replace function app.user_kits() returns setof text
language sql stable security definer set search_path = public as $$
  select id from brand_kits where customer_id = app.user_customer();
$$;

grant execute on function app.user_kits() to app_user;

comment on function app.user_kits() is
  'security definer because app_user cannot select brand_kits until its own policy '
  'applies; returns only kit ids belonging to the session customer.';

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

grant select on
  brand_kits, brand_assets, brand_fonts,
  requests, request_canvases, revisions, runs, artifacts, findings,
  messages, comment_threads, comment_messages, comment_attachments
to app_user;

create policy brand_kits_user_select on brand_kits
  for select using (app.is_app_user() and customer_id = app.user_customer());

-- Assets by OWNING kit, exactly as the run policy does. The misfiled asset in this
-- packet belongs to one customer and sits in another's folder; filtering by folder
-- here would show it to the wrong person in the UI even though a sandbox cannot
-- reach it.
create policy brand_assets_user_select on brand_assets
  for select using (app.is_app_user() and kit_id in (select app.user_kits()));

create policy brand_fonts_user_select on brand_fonts
  for select using (app.is_app_user() and kit_id in (select app.user_kits()));

create policy requests_user_select on requests
  for select using (app.is_app_user() and kit_id in (select app.user_kits()));

create policy request_canvases_user_select on request_canvases
  for select using (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  );

create policy revisions_user_select on revisions
  for select using (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  );

create policy runs_user_select on runs
  for select using (
    app.is_app_user()
    and revision_id in (
      select r.id from revisions r
        join requests q on q.id = r.request_id
       where q.kit_id in (select app.user_kits())
    )
  );

create policy artifacts_user_select on artifacts
  for select using (
    app.is_app_user()
    and revision_id in (
      select r.id from revisions r
        join requests q on q.id = r.request_id
       where q.kit_id in (select app.user_kits())
    )
  );

create policy findings_user_select on findings
  for select using (
    app.is_app_user()
    and (
      kit_id in (select app.user_kits())
      or revision_id in (
        select r.id from revisions r
          join requests q on q.id = r.request_id
         where q.kit_id in (select app.user_kits())
      )
    )
  );

create policy messages_user_select on messages
  for select using (
    app.is_app_user()
    and revision_id in (
      select r.id from revisions r
        join requests q on q.id = r.request_id
       where q.kit_id in (select app.user_kits())
    )
  );

create policy comment_threads_user_select on comment_threads
  for select using (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  );

create policy comment_messages_user_select on comment_messages
  for select using (
    app.is_app_user()
    and thread_id in (
      select t.id from comment_threads t
        join requests q on q.id = t.request_id
       where q.kit_id in (select app.user_kits())
    )
  );

create policy comment_attachments_user_select on comment_attachments
  for select using (
    app.is_app_user()
    and message_id in (
      select m.id from comment_messages m
        join comment_threads t on t.id = m.thread_id
        join requests q on q.id = t.request_id
       where q.kit_id in (select app.user_kits())
    )
  );

-- ---------------------------------------------------------------------------
-- Writes a person legitimately makes
--
-- Asking for work, commenting on it, approving or deleting a revision. Not
-- producing artifacts, not touching brand assets, not writing run rows.
-- ---------------------------------------------------------------------------

grant insert on requests, request_canvases, revisions, comment_threads, comment_messages to app_user;
grant update on comment_threads, revisions to app_user;

create policy requests_user_insert on requests
  for insert with check (app.is_app_user() and kit_id in (select app.user_kits()));

create policy request_canvases_user_insert on request_canvases
  for insert with check (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  );

create policy revisions_user_insert on revisions
  for insert with check (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  );

-- Approve, or delete. `deleted` is a status rather than a row removal, because the
-- bytes are still in storage and a delete a person regrets should be undoable.
create policy revisions_user_update on revisions
  for update using (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  )
  with check (request_id in (select id from requests where kit_id in (select app.user_kits())));

create policy comment_threads_user_insert on comment_threads
  for insert with check (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  );

-- Resolve or reopen a thread. A person decides whether their own comment was
-- addressed; a run cannot.
create policy comment_threads_user_update on comment_threads
  for update using (
    app.is_app_user()
    and request_id in (select id from requests where kit_id in (select app.user_kits()))
  )
  with check (request_id in (select id from requests where kit_id in (select app.user_kits())));

create policy comment_messages_user_insert on comment_messages
  for insert with check (
    app.is_app_user()
    and author = 'user'
    and thread_id in (
      select t.id from comment_threads t
        join requests q on q.id = t.request_id
       where q.kit_id in (select app.user_kits())
    )
  );

-- ---------------------------------------------------------------------------
-- Storage
--
-- Read the finished work of one's own customer, and upload a brand kit into a kit
-- one owns. Nothing else — a person does not write into a revision's work tree,
-- because then "only the agent moves work out of the box" would stop being true.
-- ---------------------------------------------------------------------------

grant usage on schema storage to app_user;
grant select, insert on storage.objects to app_user;
grant select on storage.buckets to app_user;

create or replace function app.user_request_prefixes() returns setof text
language sql stable security definer set search_path = public as $$
  select q.id::text
    from requests q
   where q.kit_id in (select id from brand_kits where customer_id = app.user_customer());
$$;

grant execute on function app.user_request_prefixes() to app_user;

create policy work_user_read on storage.objects
  for select using (
    bucket_id = 'work'
    and app.is_app_user()
    -- First segment is the request id. Compared as a whole segment, so a request id
    -- that merely starts with another's cannot reach across.
    and (storage.foldername(name))[1] in (select app.user_request_prefixes())
  );

create policy brains_user_read on storage.objects
  for select using (
    bucket_id = 'brains'
    and app.is_app_user()
    and (storage.foldername(name))[1] in (select app.user_kits())
  );

-- Uploading a brand kit. Screen 1 of the UI needs this; the constraint is that the
-- kit must already belong to this customer, so a customer cannot create files under
-- a kit id they do not own.
create policy brains_user_write on storage.objects
  for insert with check (
    bucket_id = 'brains'
    and app.is_app_user()
    and (storage.foldername(name))[1] in (select app.user_kits())
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant app_user to authenticator';
  end if;
end
$$;

alter default privileges in schema public revoke all on tables from app_user;

-- ---------------------------------------------------------------------------
-- Deliberately absent for app_user
--
--   any read of another customer's kit, request, revision, artifact or comment
--   insert or update on brand_assets / brand_fonts  · ingest is the backend's job
--   insert on artifacts                             · only a run produces work
--   insert or update on runs                        · only the backend starts runs
--   write into the `work` bucket                    · only the agent saves its work
--   delete on anything                              · deletion is a status change
-- ---------------------------------------------------------------------------
