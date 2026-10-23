-- ── Change sets, approvals, commits, audit ──────────────────────────────────
--
-- Replaces `changesets/$uid/$id`, `approvals/$uid/$id`, `commits/$uid/$id`, and
-- `admin/audit/$id`.
--
-- The row is not the authority here, and never was. A change set is signed by
-- the server when it is proposed and an approval is signed over the content
-- hash, so rewriting the `files` column and asking to commit produces a
-- signature that does not verify. Postgres does not change that; it only makes
-- the rows cheaper to query.

create table if not exists public.changesets (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  project_id text not null default '',
  repo_full_name text not null,
  default_branch text not null default 'main',
  base_sha text not null,
  hash text not null check (length(hash) = 64),
  branch text not null check (length(branch) between 1 and 120),
  message text not null default '',
  files jsonb not null default '[]'::jsonb,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'committed', 'stale')),
  expires_at timestamptz not null,
  signature text not null default '',
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table if not exists public.approvals (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  changeset_id text not null,
  repo_full_name text not null default '',
  base_sha text not null default '',
  hash text not null check (length(hash) = 64),
  branch text not null,
  message text not null default '',
  signature text not null default '',
  created_at timestamptz not null default now(),
  primary key (owner, changeset_id)
);

create table if not exists public.commits (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  changeset_id text not null,
  sha text not null,
  branch text not null,
  pr_url text not null default '',
  created_at timestamptz not null default now(),
  primary key (owner, changeset_id)
);

create table if not exists public.admin_audit (
  id text primary key,
  at timestamptz not null default now(),
  action text not null check (action in ('createCode', 'deleteCode', 'toggleCode', 'grantDew')),
  code text,
  dew numeric(18, 3),
  active boolean,
  uid text,
  note text
);

create index if not exists admin_audit_at_idx on public.admin_audit (at desc);

alter table public.changesets enable row level security;
alter table public.approvals enable row level security;
alter table public.commits enable row level security;
alter table public.admin_audit enable row level security;

drop policy if exists changesets_owner on public.changesets;
create policy changesets_owner on public.changesets
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists changesets_admin on public.changesets;
create policy changesets_admin on public.changesets
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists approvals_owner on public.approvals;
create policy approvals_owner on public.approvals
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists approvals_admin on public.approvals;
create policy approvals_admin on public.approvals
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists commits_owner on public.commits;
create policy commits_owner on public.commits
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists commits_admin on public.commits;
create policy commits_admin on public.commits
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- The audit ledger is the administrator's, both to write and to read. It is a
-- record of what they did, so nobody else may add an entry that looks like one.
drop policy if exists admin_audit_admin on public.admin_audit;
create policy admin_audit_admin on public.admin_audit
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.changesets to authenticated;
grant select, insert, update, delete on public.approvals to authenticated;
grant select, insert, update, delete on public.commits to authenticated;
grant select, insert, update, delete on public.admin_audit to authenticated;
