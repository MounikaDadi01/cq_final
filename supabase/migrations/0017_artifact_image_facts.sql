-- 0017 · what an artifact actually is
--
-- Until now a saved render recorded a path, a role, a content type and a byte count.
-- That is enough to fetch it and not enough to trust it. Nothing recorded its
-- dimensions, so nothing downstream could answer the one question that matters about
-- an ad — is this actually 1080x1080? — without downloading it and decoding it.
--
-- And nothing recorded a digest, which the save path was already computing and then
-- throwing away. A byte count is a weak identity: two different renders of the same
-- canvas are usually within a few hundred bytes of each other.
--
-- An audit found the consequence: a row claimed 1636 bytes while storage held 1658 and
-- there was no way to tell which was the truth. With a digest there would have been.

alter table artifacts
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists sha256 text;

comment on column artifacts.sha256 is
  'Digest of the bytes as saved. The row''s identity claim: a mismatch against storage '
  'means the record is wrong, and without it a size mismatch is unresolvable.';
comment on column artifacts.width is
  'Read from the image header at save time, so a render can be checked against the '
  'canvas it was requested at without downloading it.';

-- A render must match the canvas it belongs to. Enforced where it can be: both
-- dimensions present or neither, so a half-recorded size cannot look like a fact.
alter table artifacts
  drop constraint if exists artifacts_dimensions_together;
alter table artifacts
  add constraint artifacts_dimensions_together
  check ((width is null and height is null) or (width > 0 and height > 0));

create index if not exists artifacts_sha_idx on artifacts (sha256) where sha256 is not null;
