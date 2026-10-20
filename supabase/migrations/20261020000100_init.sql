-- OpenMi — Phase 1 schema.
-- Postgres 15+ (Supabase). All writes go through the Worker's service role;
-- RLS exists so a leaked anon key still cannot read other users' rows.

create extension if not exists pgcrypto;

do $$
begin
  create type public.task_status as enum ('queued', 'running', 'succeeded', 'failed');
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  github_login text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- github_credentials (one per user, token encrypted with AES-256-GCM)
-- ---------------------------------------------------------------------------
create table if not exists public.github_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  github_login text not null,
  token_ciphertext text not null,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  repo_full_name text not null check (repo_full_name ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'),
  default_branch text not null default 'main',
  commit_mode text not null default 'direct' check (commit_mode in ('direct', 'pull_request')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, repo_full_name)
);

create index if not exists projects_owner_idx on public.projects (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  prompt text not null check (char_length(prompt) between 1 and 4000),
  status public.task_status not null default 'queued',
  workflow_instance_id text,
  base_branch text,
  base_commit_sha text,
  model text,
  summary text,
  patch jsonb,
  files_changed integer not null default 0 check (files_changed >= 0),
  commit_sha text,
  commit_url text,
  branch text,
  error_code text,
  error_message text,
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists tasks_owner_created_idx on public.tasks (owner_id, created_at desc);
create index if not exists tasks_project_created_idx on public.tasks (project_id, created_at desc);
create index if not exists tasks_active_idx on public.tasks (owner_id) where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- task_events (append-only timeline shown on the phone)
-- ---------------------------------------------------------------------------
create table if not exists public.task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks (id) on delete cascade,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  message text not null check (char_length(message) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists task_events_task_idx on public.task_events (task_id, id);

-- ---------------------------------------------------------------------------
-- usage_daily (per-user, per-UTC-day counters for budget protection)
-- ---------------------------------------------------------------------------
create table if not exists public.usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  tasks_started integer not null default 0 check (tasks_started >= 0),
  ai_calls integer not null default 0 check (ai_calls >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists github_credentials_touch on public.github_credentials;
create trigger github_credentials_touch before update on public.github_credentials
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security: read-only, owner-scoped. No client writes.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.github_credentials enable row level security;
alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_events enable row level security;
alter table public.usage_daily enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);

-- Token ciphertext is intentionally not selectable by end users.
drop policy if exists github_credentials_no_client_access on public.github_credentials;
create policy github_credentials_no_client_access on public.github_credentials
  for select to authenticated using (false);

drop policy if exists projects_select_own on public.projects;
create policy projects_select_own on public.projects
  for select to authenticated using (auth.uid() = owner_id);

drop policy if exists tasks_select_own on public.tasks;
create policy tasks_select_own on public.tasks
  for select to authenticated using (auth.uid() = owner_id);

drop policy if exists task_events_select_own on public.task_events;
create policy task_events_select_own on public.task_events
  for select to authenticated using (
    exists (
      select 1 from public.tasks t
      where t.id = task_events.task_id and t.owner_id = auth.uid()
    )
  );

drop policy if exists usage_daily_select_own on public.usage_daily;
create policy usage_daily_select_own on public.usage_daily
  for select to authenticated using (auth.uid() = user_id);
