-- ── GitHub connections and pinned projects ──────────────────────────────────
--
-- Replaces `users/$uid/github` (the legacy single connection, still honoured),
-- `users/$uid/githubConnections/$id`, `users/$uid/githubDefault`, and
-- `projects/$uid/$id`.
--
-- The token column holds ciphertext, sealed by lib/github/crypto.ts with the
-- deployment's own key. A rotated key makes every connection unreadable rather
-- than wrong, and the remedy is to reconnect — the same remedy a revoked token
-- has. What is stored here is never returned to a browser: the routes answer
-- with a summary that has no token in it.

create table if not exists public.github_links (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token text not null,
  login text not null default '',
  scopes text not null default '',
  linked_at timestamptz not null default now()
);

create table if not exists public.github_connections (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  token text not null,
  login text not null check (length(login) between 1 and 100),
  scopes text not null default '' check (length(scopes) <= 200),
  kind text not null check (kind in ('pat', 'oauth')),
  label text not null check (length(label) between 1 and 40),
  can_read_repos boolean not null default false,
  linked_at timestamptz not null default now(),
  primary key (owner, id)
);

create index if not exists github_connections_owner_idx
  on public.github_connections (owner, linked_at desc);

create table if not exists public.github_default (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  connection_id text not null,
  at timestamptz not null default now()
);

create table if not exists public.projects (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  repo_full_name text not null check (length(repo_full_name) <= 140),
  default_branch text not null default 'main' check (length(default_branch) <= 120),
  base_sha text not null default '' check (length(base_sha) <= 64),
  can_push boolean not null default false,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

create index if not exists projects_owner_updated_idx
  on public.projects (owner, updated_at desc);

alter table public.github_links enable row level security;
alter table public.github_connections enable row level security;
alter table public.github_default enable row level security;
alter table public.projects enable row level security;

drop policy if exists github_links_owner on public.github_links;
create policy github_links_owner on public.github_links
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists github_links_admin on public.github_links;
create policy github_links_admin on public.github_links
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists github_connections_owner on public.github_connections;
create policy github_connections_owner on public.github_connections
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists github_connections_admin on public.github_connections;
create policy github_connections_admin on public.github_connections
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists github_default_owner on public.github_default;
create policy github_default_owner on public.github_default
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists github_default_admin on public.github_default;
create policy github_default_admin on public.github_default
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists projects_owner on public.projects;
create policy projects_owner on public.projects
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists projects_admin on public.projects;
create policy projects_admin on public.projects
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.github_links to authenticated;
grant select, insert, update, delete on public.github_connections to authenticated;
grant select, insert, update, delete on public.github_default to authenticated;
grant select, insert, update, delete on public.projects to authenticated;
