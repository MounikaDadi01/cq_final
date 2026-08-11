-- 0004 · assertions the database makes about itself
--
-- Deny-by-default is a property of every table, not of this repo's good
-- intentions. A table added later with RLS left off is an open door, and the
-- migration that added it would look perfectly reasonable in review.
--
-- So the check lives in the database and CI calls it. It reads pg_class rather
-- than re-reading 0002, because the question is what is true of the running
-- schema, not what a file says.

create or replace function app.assert_rls_everywhere()
returns table (table_name text, rls_enabled boolean, policy_count bigint)
language sql stable as $$
  select c.relname::text,
         c.relrowsecurity,
         (select count(*) from pg_policy p where p.polrelid = c.oid)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
   order by c.relname;
$$;

-- Fails loudly rather than returning a report nobody reads.
create or replace function app.require_rls_everywhere() returns void
language plpgsql stable as $$
declare
  offenders text;
begin
  select string_agg(table_name, ', ')
    into offenders
    from app.assert_rls_everywhere()
   where not rls_enabled;

  if offenders is not null then
    raise exception 'row level security is off on: %', offenders;
  end if;
end;
$$;

comment on function app.require_rls_everywhere() is
  'Called by CI. A new table with RLS off fails the build.';

-- A table with RLS on and no policy is unreachable, which is safe but is almost
-- always an oversight. Reported separately so "locked" and "forgotten" do not
-- look the same — the same reason findings carry `unverifiable` alongside
-- pass and fail.
create or replace function app.tables_without_policies()
returns table (table_name text)
language sql stable as $$
  select table_name from app.assert_rls_everywhere()
   where rls_enabled and policy_count = 0;
$$;
