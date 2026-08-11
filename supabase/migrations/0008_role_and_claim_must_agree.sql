-- 0008 · the connected role and the claimed role must agree
--
-- Found by a test that was meant to be a formality.
--
-- A Postgres policy with no `TO` clause applies to every role. So a session
-- connected as `sandbox_deploy` while carrying `role: sandbox_run` in its claims
-- satisfied `app.is_run()`, and the generation policies admitted it. Two
-- credentials' worth of access from one token.
--
-- In practice PostgREST switches the database role to whatever the `role` claim
-- names, so the two always agree and the hole is unreachable through the API. That
-- is exactly the kind of reasoning worth distrusting: it makes the guarantee a
-- property of a component we do not control, and it evaporates the moment anything
-- else opens a connection — a migration script, a worker, a psql session.
--
-- Fixed in the two claim readers rather than by adding `TO` clauses to twenty
-- policies. One place to get right, and it states the rule as a sentence: a run is
-- a token *and* a role, and a mismatch is neither.

create or replace function app.is_run() returns boolean
language sql stable as $$
  select app.claim('role') = 'sandbox_run'
     and current_role = 'sandbox_run'
     and app.run_revision() is not null
     and app.run_id() is not null;
$$;

create or replace function app.is_deploy() returns boolean
language sql stable as $$
  select app.claim('role') = 'sandbox_deploy'
     and current_role = 'sandbox_deploy'
     and app.run_revision() is not null
     and app.run_id() is not null;
$$;

comment on function app.is_run() is
  'True only when the token claims sandbox_run AND the session is connected as '
  'sandbox_run. A token whose claim disagrees with its connection is not a '
  'weaker run — it is not a run.';

comment on function app.is_deploy() is
  'As app.is_run(), for deployment. The symmetry is the point: neither box can '
  'borrow the other role by presenting the other claim.';
