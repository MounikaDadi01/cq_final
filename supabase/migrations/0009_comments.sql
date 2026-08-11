-- 0009 · comments, pinned to regions, carried across revisions
--
-- From the reference UI: "Click item or drag an area to comment", and comments that
-- outlive the asset they were left on. Both of those are schema decisions, not
-- rendering decisions.
--
-- A comment is pinned to a **region**, not a point. A point tells you where someone
-- clicked; a rectangle tells you what they were talking about — and a rectangle is
-- what an agent can act on, because "this area" is an instruction and "this pixel"
-- is not.
--
-- Regions are stored as fractions of the canvas, never pixels. The same comment has
-- to mean the same thing on a 1080x1080 and a 1200x628, and it has to survive a
-- revision that re-renders at a different size. Pixels would silently drift.

create table comment_threads (
  id            uuid primary key default gen_random_uuid(),

  -- Anchored to the REQUEST, not the revision.
  --
  -- This is the whole "comments outlive the asset" property. A thread opened on
  -- rev 1 is still the same conversation on rev 3, so it cannot belong to a
  -- revision — it belongs to the work, and records which revision it was opened
  -- against for context.
  request_id    uuid not null references requests (id) on delete cascade,
  opened_on_revision uuid references revisions (id) on delete set null,

  -- Which canvas the region was drawn on. Null means the whole request.
  canvas_name   text,

  -- Fractions of the canvas, 0..1. Null for a thread with no region — a general
  -- note about the request rather than a pin on an area.
  region_x      double precision check (region_x >= 0 and region_x <= 1),
  region_y      double precision check (region_y >= 0 and region_y <= 1),
  region_w      double precision check (region_w > 0 and region_w <= 1),
  region_h      double precision check (region_h > 0 and region_h <= 1),

  status        text not null default 'open' check (status in ('open', 'resolved')),
  resolved_on_revision uuid references revisions (id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A region is all four values or none. Three of four is a rectangle nobody can
  -- draw, and it would fail somewhere far from here.
  constraint region_is_whole check (
    (region_x is null and region_y is null and region_w is null and region_h is null)
    or (region_x is not null and region_y is not null and region_w is not null and region_h is not null)
  )
);

create index comment_threads_request_idx on comment_threads (request_id, status);

comment on table comment_threads is
  'A conversation about an area of an asset. Belongs to the request so it survives '
  'every revision; records which revision it was opened against.';

create table comment_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references comment_threads (id) on delete cascade,

  -- `user` is a person, `agent` is a run answering. Kept apart because a run may
  -- add to a thread and must never be able to impersonate the person in it.
  author      text not null check (author in ('user', 'agent')),
  run_id      uuid references runs (id) on delete set null,
  body        text not null,

  /**
   * What the person asked for, as the agent should receive it.
   *
   * The visible message is written for a human. This is the same request phrased as
   * an instruction, and it is what travels into the next run's hydration file. Null
   * when the message is discussion rather than a change request — a thread can
   * contain both, and only the change requests should reach the agent.
   */
  instruction text,

  created_at  timestamptz not null default now()
);

create index comment_messages_thread_idx on comment_messages (thread_id, created_at);

-- Attachments on a comment: an uploaded reference, or an image the agent generated
-- into the region. Points at an artifact rather than duplicating bytes.
create table comment_attachments (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references comment_messages (id) on delete cascade,
  artifact_id uuid references artifacts (id) on delete set null,
  storage_key text,
  created_at  timestamptz not null default now()
);

create index comment_attachments_message_idx on comment_attachments (message_id);

create trigger comment_threads_touch before update on comment_threads
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS, on from the start
--
-- Enabled before any policy exists, so these tables are unreachable until
-- something is granted deliberately. A new table with RLS off is the one hole
-- 0004's assertion exists to catch, and adding three tables is exactly when that
-- gets forgotten.
-- ---------------------------------------------------------------------------

alter table comment_threads enable row level security;
alter table comment_messages enable row level security;
alter table comment_attachments enable row level security;
alter table comment_threads force row level security;
alter table comment_messages force row level security;
alter table comment_attachments force row level security;

-- ---------------------------------------------------------------------------
-- What a generation run may do with comments
--
-- Read every thread on its own request, so it can see what it is being asked to
-- change and what was already discussed. Reply as `agent`. Resolve nothing: a
-- person decides whether their own comment was addressed, and a run marking its
-- own work resolved would be grading itself.
-- ---------------------------------------------------------------------------

create policy comment_threads_run_select on comment_threads
  for select using (
    app.is_run()
    and request_id in (select request_id from revisions where id = app.run_revision())
  );

create policy comment_messages_run_select on comment_messages
  for select using (
    app.is_run()
    and thread_id in (
      select t.id from comment_threads t
       where t.request_id in (select request_id from revisions where id = app.run_revision())
    )
  );

create policy comment_messages_run_insert on comment_messages
  for insert with check (
    app.is_run()
    and author = 'agent'
    and run_id = app.run_id()
    and thread_id in (
      select t.id from comment_threads t
       where t.request_id in (select request_id from revisions where id = app.run_revision())
    )
  );

create policy comment_attachments_run_select on comment_attachments
  for select using (
    app.is_run()
    and message_id in (
      select m.id from comment_messages m
        join comment_threads t on t.id = m.thread_id
       where t.request_id in (select request_id from revisions where id = app.run_revision())
    )
  );

grant select on comment_threads, comment_messages, comment_attachments to sandbox_run;
grant insert on comment_messages to sandbox_run;

-- Deliberately absent for a run:
--   insert or update on comment_threads   · a run does not open or close a thread
--   update on comment_messages            · nothing rewrites what was said
--   any access for sandbox_deploy          · a deploy box has no business in a
--                                            design conversation
