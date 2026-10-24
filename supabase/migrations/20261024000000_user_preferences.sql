-- ── Preferences that follow the account ─────────────────────────────────────
--
-- Now that every visitor is a real `auth.users` row, the small choices that make
-- Openmi feel like theirs — appearance, response length, reasoning effort, search
-- mode, the last model, whether the tour has been seen, and the display name —
-- belong in the database rather than in one browser's localStorage.
--
-- localStorage is still written first, because it is instant and it is what the
-- first paint reads. This table is the copy that makes a second browser open with
-- the same settings. A read failure is therefore not an error: the local copy
-- stands, and the next successful write repairs the row.
--
-- Ownership is the same rule as every other user table: the row's `owner`
-- defaults to `auth.uid()`, RLS compares it with `auth.uid()`, and the
-- administrator may read and write all rows. No service-role key is involved.

create table if not exists public.user_preferences (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  display_name text check (display_name is null or length(display_name) <= 40),
  appearance text not null default 'dark' check (appearance in ('dark', 'light')),
  response_length text not null default 'balanced'
    check (response_length in ('short', 'balanced', 'detailed')),
  reasoning_effort text not null default 'low'
    check (reasoning_effort in ('low', 'medium', 'high')),
  search_mode text not null default 'auto'
    check (search_mode in ('auto', 'always', 'off')),
  model text check (model is null or length(model) <= 40),
  tutorial_finished boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_preferences enable row level security;

drop policy if exists user_preferences_owner on public.user_preferences;
create policy user_preferences_owner on public.user_preferences
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists user_preferences_admin on public.user_preferences;
create policy user_preferences_admin on public.user_preferences
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.user_preferences to authenticated;
