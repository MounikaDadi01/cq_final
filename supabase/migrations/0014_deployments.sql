-- 0014 · deployments
--
-- A named group of approved artifacts, and the record of pushing them into a
-- marketing tool. Deploying is the brief's one automatic disqualifier, so what this
-- table has to answer is not "did we try" but "did it demonstrably happen".
--
-- Hence `verified_url` and `recording_artifact_id` as separate columns from `status`:
-- a deploy that reports success with neither is not a deploy, it is a claim.

create table deployments (
  id            uuid primary key default gen_random_uuid(),
  kit_id        text not null references brand_kits (id) on delete cascade,
  name          text not null,

  target_tool   text not null default 'adstream',
  target_url    text not null,

  status        text not null default 'planned'
                check (status in ('planned', 'running', 'published', 'unverified', 'stopped', 'failed')),

  -- What the tool gave back, read off the page after publishing. Null means nobody
  -- confirmed anything, which is why `unverified` exists as a distinct status.
  verified_url  text,
  verified_note text,

  recording_artifact_id uuid references artifacts (id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (kit_id, name)
);

create index deployments_kit_idx on deployments (kit_id, status);

-- Which revisions ship in this deployment. Many-to-many, because a launch can group
-- several approved revisions and a revision can be re-deployed.
create table deployment_items (
  id            uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references deployments (id) on delete cascade,
  revision_id   uuid not null references revisions (id) on delete cascade,
  canvas_name   text,
  unique (deployment_id, revision_id, canvas_name)
);

create index deployment_items_deployment_idx on deployment_items (deployment_id);

create table deploy_runs (
  id            uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references deployments (id) on delete cascade,
  run_id        uuid references runs (id) on delete set null,
  status        text not null default 'starting'
                check (status in ('starting', 'running', 'completed', 'failed', 'aborted')),
  exit_reason   text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create index deploy_runs_deployment_idx on deploy_runs (deployment_id);

create trigger deployments_touch before update on deployments
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table deployments enable row level security;
alter table deployment_items enable row level security;
alter table deploy_runs enable row level security;
alter table deployments force row level security;
alter table deployment_items force row level security;
alter table deploy_runs force row level security;

grant select on deployments, deployment_items, deploy_runs to app_user;
grant insert on deployments, deployment_items to app_user;

create policy deployments_user_select on deployments
  for select using (app.is_app_user() and kit_id in (select app.user_kits()));

create policy deployments_user_insert on deployments
  for insert with check (app.is_app_user() and kit_id in (select app.user_kits()));

create or replace function app.user_deployments() returns setof uuid
language sql stable security definer set search_path = public as $$
  select d.id
    from deployments d
    join brand_kits k on k.id = d.kit_id
   where k.customer_id = app.user_customer();
$$;

grant execute on function app.user_deployments() to app_user;

create policy deployment_items_user_select on deployment_items
  for select using (app.is_app_user() and deployment_id in (select app.user_deployments()));

-- A person may only add an approved revision they own. Unapproved work reaching a
-- deployment is how a half-finished ad gets published.
create policy deployment_items_user_insert on deployment_items
  for insert with check (
    app.is_app_user()
    and deployment_id in (select app.user_deployments())
    and revision_id in (
      select id from revisions where id in (select app.user_revisions()) and approved_at is not null
    )
  );

create policy deploy_runs_user_select on deploy_runs
  for select using (app.is_app_user() and deployment_id in (select app.user_deployments()));

-- ---------------------------------------------------------------------------
-- What a deploy box may do
--
-- Read its own deployment, and report the outcome. It cannot create a deployment,
-- add items, or touch another one.
-- ---------------------------------------------------------------------------

create or replace function app.deploy_deployment() returns uuid
language sql stable security definer set search_path = public as $$
  select deployment_id from deploy_runs where run_id = app.run_id() limit 1;
$$;

grant execute on function app.deploy_deployment() to sandbox_deploy;
grant select on deployments, deployment_items to sandbox_deploy;
grant update on deployments to sandbox_deploy;
grant select, update on deploy_runs to sandbox_deploy;

create policy deployments_deploy_select on deployments
  for select using (app.is_deploy() and id = app.deploy_deployment());

create policy deployments_deploy_update on deployments
  for update using (app.is_deploy() and id = app.deploy_deployment())
  with check (id = app.deploy_deployment());

create policy deployment_items_deploy_select on deployment_items
  for select using (app.is_deploy() and deployment_id = app.deploy_deployment());

create policy deploy_runs_deploy_select on deploy_runs
  for select using (app.is_deploy() and deployment_id = app.deploy_deployment());

create policy deploy_runs_deploy_update on deploy_runs
  for update using (app.is_deploy() and deployment_id = app.deploy_deployment())
  with check (deployment_id = app.deploy_deployment());
