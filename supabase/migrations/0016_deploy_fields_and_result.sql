-- 0016 · arbitrary tool fields, and a deploy box that can file its own report
--
-- Two things the first real deploys taught, in order.
--
-- **Every tool wants different fields.** Adstream needs a campaign and objective at
-- step one, then audience, placement and a daily budget at step two. Adding a column
-- per field would mean a migration every time a tool changes a form, and the next tool
-- would need a different set anyway. So the values a person supplies for the tool live
-- in one document, and the agent stops when something it needs is absent.
--
-- **A deploy could not save its own RESULT.json.** The insert policy allowed only
-- `recording`, so the report was refused with a row-level-security violation while the
-- video saved fine. The narrow policy was right in spirit — a deploy must not be able
-- to forge a render — and wrong by one role: its own account of what it did is not a
-- render, and refusing it means the only record of a stopped deploy is a log that dies
-- with the box.

alter table deployments
  add column if not exists target_fields jsonb not null default '{}'::jsonb;

comment on column deployments.target_fields is
  'Values a person supplied for the tool''s own form: audience, placement, budget, '
  'whatever it asks for. The agent stops rather than inventing anything absent here.';

drop policy artifacts_deploy_insert on artifacts;

create policy artifacts_deploy_insert on artifacts
  for insert with check (
    app.is_deploy()
    and revision_id = app.run_revision()
    -- A recording, and the deploy's own report. Still not a render, a plate or an
    -- asset: a deploy box cannot manufacture the work it was asked to publish.
    and role in ('recording', 'result')
  );

comment on policy artifacts_deploy_insert on artifacts is
  'Deploy writes its recording and its own RESULT.json. Never a render, plate or '
  'asset — the artifact role stays trustworthy evidence of which box made what.';
