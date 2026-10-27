-- ── Where an approved change is written ─────────────────────────────────────
--
-- Commits used to have exactly one outcome: an `agent/` branch and a pull
-- request. The review screen now asks where the change should land — straight
-- to the default branch, a pull request, or a branch on its own — and a project
-- can remember the answer.
--
-- `ask` is the default so nothing changes for an existing project: the card
-- shows the three choices every time. A remembered answer is opt-in, and setting
-- it back to `ask` is the way out — which is why it is a stored value rather
-- than a checkbox the interface keeps for itself.
--
-- `commits.destination` records where a commit actually went. Without it a
-- reopened review card could only guess from an empty `pr_url`, and "pushed a
-- branch with no PR" and "pushed straight to main" would look the same.

alter table public.projects
  add column if not exists commit_destination text not null default 'ask'
  check (commit_destination in ('ask', 'main', 'pr', 'branch'));

alter table public.commits
  add column if not exists destination text not null default 'pr'
  check (destination in ('main', 'pr', 'branch'));

insert into public.schema_expected (object_name, kind, migration) values
  ('projects.commit_destination', 'column', '20261030000000_commit_destination'),
  ('commits.destination', 'column', '20261030000000_commit_destination')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;
