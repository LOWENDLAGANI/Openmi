-- ── A repository turn that keeps running after the tab is closed ────────────
--
-- One row per turn. The row is the run: status, what has been written, which
-- steps ran, and the sealed blob the next step needs (GitHub token, provider
-- keys, transcript, signed turn token).
--
-- Writing is deliberately *not* granted to the browser. `changesets` is owner
-- writable because the row is derived from a diff the person is reviewing; a run
-- is working state that a client must not be able to fabricate, rewind or mark
-- finished. So:
--
--   - `authenticated` may SELECT its own rows, and that is all. The chat polls
--     its run with the caller's own token, so RLS decides what it may watch.
--   - INSERT / UPDATE / DELETE happen through the service-role key held by the
--     run tick (`lib/supabaseAdmin.ts`), which bypasses RLS by design.
--
-- The consequence is worth stating: the owner can read `state`, and it is
-- unreadable anyway — it is AES-256-GCM ciphertext sealed with a key that never
-- leaves the server.

create table if not exists public.agent_runs (
  owner uuid not null references auth.users (id) on delete cascade,
  id uuid not null,
  project_id text not null default '',
  repo_full_name text not null default '',
  status text not null default 'running'
    check (status in ('running', 'done', 'failed', 'cancelled')),
  -- What the person will read: the answer so far, and the reads behind it.
  content text not null default '',
  steps jsonb not null default '[]'::jsonb,
  proposals jsonb not null default '[]'::jsonb,
  changeset_id text,
  review jsonb,
  truncated boolean not null default false,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  error text,
  -- Sealed working state for the next tick. Never parsed by anything but the tick.
  state text not null default '',
  -- The attempt number a tick must present to claim this run. This is the
  -- idempotency guard: two ticks holding the same number cannot both win.
  attempts integer not null default 0,
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

-- The chat asks "is anything of mine still running on this repository?" on load.
create index if not exists agent_runs_owner_status_idx
  on public.agent_runs (owner, status, created_at desc);

-- The watchdog asks "which runs stopped beating?" — the one query that is not
-- scoped to an owner, and therefore the one only the service key can make.
create index if not exists agent_runs_heartbeat_idx
  on public.agent_runs (status, heartbeat_at);

alter table public.agent_runs enable row level security;

drop policy if exists agent_runs_owner_read on public.agent_runs;
create policy agent_runs_owner_read on public.agent_runs
  for select to authenticated
  using (owner = auth.uid());

-- The administrator keeps the same visibility they have everywhere else: a
-- support question about a stuck run should not need a database console.
drop policy if exists agent_runs_admin on public.agent_runs;
create policy agent_runs_admin on public.agent_runs
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Select only. A run is started and advanced by the tick, never by a browser.
grant select on public.agent_runs to authenticated;
