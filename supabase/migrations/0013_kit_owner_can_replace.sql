-- 0013 · a kit's owner may replace its own files
--
-- The upload route used `x-upsert` and would have failed with "permission denied for
-- table objects", exactly as `save_work` did — `app_user` had INSERT and SELECT and no
-- UPDATE. The second time the same wall appeared, which is worth noting, because the
-- two cases are not the same and only one of them should hit it.
--
-- Append-only exists so a *sandbox* cannot rewrite or erase what it saved: the record
-- of a run has to be trustworthy evidence. A person maintaining their own brand kit is
-- a different act entirely. Replacing a logo is the normal way a brand changes, and
-- refusing it would mean every corrected file arrived as `logo-v2-final.svg`.
--
-- So: the owner may overwrite inside their own kit prefix, and nothing else changes.
-- Runs stay append-only, and no role gains UPDATE on the `work` bucket.

grant update on storage.objects to app_user;

create policy brains_user_replace on storage.objects
  for update using (
    bucket_id = 'brains'
    and app.is_app_user()
    and (storage.foldername(name))[1] in (select app.user_kits())
  )
  with check (
    bucket_id = 'brains'
    and app.is_app_user()
    and (storage.foldername(name))[1] in (select app.user_kits())
  );

comment on policy brains_user_replace on storage.objects is
  'Owner may replace files in its own kit. Deliberately no equivalent on the work '
  'bucket: a run must never be able to overwrite what it saved.';
