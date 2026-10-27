-- ── A change that was pushed straight to the default branch ──────────────────
--
-- A change set has always carried the branch it would be committed to, derived
-- from its own id (`agent/<slug>-<id>`) and covered by the server's signature.
-- That is the review path: an `agent/` branch and a pull request.
--
-- A person may also ask for a change to go straight to their branch — "build me
-- a login and push it to main when you're done". When they do, the change set is
-- built in *direct* mode instead: its branch is the repository's default branch,
-- it is committed without a pull request, and `direct` is set so the commit gate
-- and the write module can tell the two apart.
--
-- The flag is not authority on its own and never was meant to be. It lives
-- inside the signed payload, so a row built for review cannot be relabelled as a
-- direct push by editing the table: the digest stops matching. It is recorded
-- here as well so the audit trail shows which path a commit took, and so the
-- review card can say which one it was.

alter table public.changesets
  add column if not exists direct boolean not null default false;

alter table public.commits
  add column if not exists direct boolean not null default false;

comment on column public.changesets.direct is
  'True when the change set was built for a direct push to the default branch at the user''s own request. Part of the signed payload, not a permission.';

comment on column public.commits.direct is
  'True when this commit went to the default branch instead of an agent/ branch with a pull request.';
