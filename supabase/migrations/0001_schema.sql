-- 0001 · schema
--
-- Ten tables, in dependency order. Numbered migrations rather than a generated
-- shape so a reviewer can see how the structure was reached, not just what it
-- ended up as.
--
-- No customer, kit, brand or campaign name appears anywhere in this file. A kit
-- is a row. Anything that named one here would be a value baked into code, and
-- a third brand has to arrive without a migration.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Brands
-- ---------------------------------------------------------------------------

create table brand_kits (
  -- The kit id as the manifest states it. Text, not a generated uuid: identity
  -- comes from the manifest, so the manifest's own value is the primary key and
  -- nothing has to be mapped.
  id            text primary key,
  customer_id   text not null,
  display_name  text not null,
  -- `pending` until ingest has resolved every asset and font.
  ingest_status  text not null default 'pending'
                 check (ingest_status in ('pending', 'ready', 'blocked')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column brand_kits.customer_id is
  'One customer may own several kits; a request pins exactly one.';

create table brand_assets (
  id               uuid primary key default gen_random_uuid(),

  -- The kit that OWNS this asset, taken from the manifest entry's own
  -- brand_kit_id. This is the column every policy filters on.
  kit_id           text not null references brand_kits (id) on delete cascade,

  -- The kit whose folder the file was found in. Usually equal to kit_id.
  -- When it differs the asset was misfiled, and keeping both columns is what
  -- lets the row be quarantined rather than deleted: the evidence survives and
  -- the asset is still invisible to the wrong tenant, because policies read
  -- kit_id and never this.
  found_in_kit_id  text not null references brand_kits (id) on delete cascade,

  kind             text not null,
  manifest_path    text not null,
  storage_key      text,

  -- False when the manifest names a path with no file behind it. A path is not
  -- an asset, so this is recorded rather than inferred at read time.
  available        boolean not null default false,
  unavailable_reason text,

  natural_width    integer,
  natural_height   integer,
  -- The manifest's own note. Load-bearing: a kit may state its reverse-logo
  -- switch point here as a colour, and a brand stating its own rule outranks
  -- any threshold of ours.
  notes            text,

  created_at       timestamptz not null default now(),

  unique (found_in_kit_id, manifest_path)
);

create index brand_assets_kit_kind_idx on brand_assets (kit_id, kind) where available;
create index brand_assets_misfiled_idx on brand_assets (found_in_kit_id)
  where kit_id <> found_in_kit_id;

create table brand_fonts (
  id           uuid primary key default gen_random_uuid(),
  kit_id       text not null references brand_kits (id) on delete cascade,
  family_slug  text not null,
  weight       integer not null,
  style        text not null default 'normal',
  storage_key  text not null,
  created_at   timestamptz not null default now(),
  unique (kit_id, family_slug, weight, style)
);

comment on table brand_fonts is
  'Only families with a file behind them. A family named in DESIGN.md but absent '
  'here is a substitution to be recorded, never a browser fallback.';

-- ---------------------------------------------------------------------------
-- Work
-- ---------------------------------------------------------------------------

create table requests (
  id              uuid primary key default gen_random_uuid(),
  kit_id          text not null references brand_kits (id) on delete restrict,
  kind            text not null check (kind in ('new', 'edit')),
  campaign_name   text not null,

  -- Copy travels as a document because its shape is the request's business, not
  -- the schema's: a kit that wants two subheads must not need a migration.
  copy            jsonb not null default '{}'::jsonb,
  plate_direction text,

  -- Exact filenames. An inspiration is consulted only when attached here; one
  -- merely sitting in a directory is not selected.
  inspirations    text[] not null default '{}',

  created_at      timestamptz not null default now(),
  created_by      text
);

create index requests_kit_idx on requests (kit_id);

create table request_canvases (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references requests (id) on delete cascade,
  name        text not null,
  width       integer not null check (width > 0),
  height      integer not null check (height > 0),

  -- A canvas the model cannot express is a finding, not a failed run, so the
  -- refusal is stored beside the request that asked for it.
  producible  boolean not null default true,
  refusal     text,

  unique (request_id, name)
);

create table revisions (
  id                  uuid primary key default gen_random_uuid(),
  request_id          uuid not null references requests (id) on delete cascade,
  n                   integer not null check (n >= 1),

  -- An edit revises a parent. Null on the first revision of a request.
  parent_revision_id  uuid references revisions (id) on delete set null,

  status              text not null default 'draft'
                      check (status in ('draft', 'running', 'partial', 'complete', 'failed', 'deleted')),

  -- `partial` is a first-class state, not an error: a box that dies mid-run
  -- leaves real work behind, and a human decides whether to keep or re-run it.
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (request_id, n)
);

create index revisions_request_idx on revisions (request_id);

create table messages (
  id           uuid primary key default gen_random_uuid(),
  revision_id  uuid not null references revisions (id) on delete cascade,
  role         text not null check (role in ('user', 'agent', 'system')),
  body         text not null,
  created_at   timestamptz not null default now()
);

create index messages_revision_idx on messages (revision_id, created_at);

create table runs (
  id                uuid primary key default gen_random_uuid(),
  revision_id       uuid not null references revisions (id) on delete cascade,

  sandbox_provider  text not null,
  -- The provider's handle. Deliberately not a name we compose: a box identity
  -- that spelled out a tenant or a task would leak one.
  sandbox_id        text,

  status            text not null default 'starting'
                    check (status in ('starting', 'running', 'saving', 'completed', 'aborted', 'failed')),

  -- Liveness is asked of the provider rather than self-reported, so a box that
  -- dies silently is still known to be gone. These record what was observed.
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  exit_reason       text,
  -- True when the supervisor saved what existed before the box went away.
  saved_partial     boolean not null default false,

  created_at        timestamptz not null default now()
);

create index runs_revision_idx on runs (revision_id);

create table artifacts (
  id            uuid primary key default gen_random_uuid(),
  revision_id   uuid not null references revisions (id) on delete cascade,
  run_id        uuid references runs (id) on delete set null,

  -- The relative path IS the identity. One tree in, one tree out: the storage
  -- key is this path under the revision's prefix, so nothing has to reconcile a
  -- flat key space against a nested tree.
  relative_path text not null,
  storage_key   text not null,

  role          text not null
                check (role in ('render', 'plate', 'html', 'asset', 'result', 'recording', 'other')),
  canvas_name   text,
  content_type  text,
  bytes         bigint,

  created_at    timestamptz not null default now(),

  unique (revision_id, relative_path)
);

create index artifacts_revision_idx on artifacts (revision_id, role);

create table findings (
  id           uuid primary key default gen_random_uuid(),
  revision_id  uuid references revisions (id) on delete cascade,
  run_id       uuid references runs (id) on delete set null,
  kit_id       text references brand_kits (id) on delete cascade,

  code         text not null,
  severity     text not null check (severity in ('blocker', 'review', 'info')),

  -- Three outcomes, not two. `unverifiable` exists so that "nothing failed" and
  -- "nothing was checked" can never look the same in a report.
  outcome      text check (outcome in ('pass', 'fail', 'unverifiable')),

  detail       text not null,
  created_at   timestamptz not null default now()
);

create index findings_revision_idx on findings (revision_id);
create index findings_kit_idx on findings (kit_id);

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger brand_kits_touch before update on brand_kits
  for each row execute function touch_updated_at();
create trigger revisions_touch before update on revisions
  for each row execute function touch_updated_at();
