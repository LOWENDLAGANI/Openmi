-- ── Folders and trash that follow the account ───────────────────────────────
--
-- The sidebar used to be a device-local view: folders lived in this browser and
-- the trash was a thirty-day local holding pen. Now that every visitor is a real
-- account, both follow the person, so a chat filed under "Work" on a phone is
-- filed under "Work" on the computer, and a chat deleted on either device leaves
-- the list everywhere and can be restored from either trash.
--
-- ── Deletions are soft, because tabs disagree ───────────────────────────────
-- A hard DELETE would be indistinguishable from "never seen here": another
-- device that still holds the folder or the trashed chat would simply upload it
-- again on its next sync, resurrecting something somebody deleted. So both
-- tables carry a removal timestamp and reads skip removed rows. An upsert of an
-- active folder deliberately does not send `deleted_at`, which means a stale
-- device cannot reopen a folder that was soft-deleted — the column is left
-- alone by the write.
--
-- `trash.messages` is the whole thread as JSONB, because restoring a chat has to
-- put back the exact conversation that was deleted, not an empty shell. The app
-- validates every message on the way in with the same parser the live history
-- uses; the column is a snapshot, not a second source of truth.
--
-- Ownership is the same rule as every other user table: `owner` defaults to
-- `auth.uid()`, RLS compares it with `auth.uid()`, and the administrator may
-- read and write all rows. No service-role key is involved.

create table if not exists public.folders (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists folders_owner_name_idx on public.folders (owner, name);

-- A chat's folder is an id, not a relationship the database needs to police:
-- both rows are owner-scoped, and a stale id simply renders as unfiled while the
-- folder list is still loading. No foreign key also means deleting a folder can
-- never take a conversation with it.
alter table public.chats add column if not exists folder_id text;

create index if not exists chats_owner_folder_idx on public.chats (owner, folder_id);

create table if not exists public.trash (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Untitled',
  pinned boolean not null default false,
  folder_id text,
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz not null default now(),
  -- Set when the chat is restored or deleted forever. The row stays so every
  -- device learns that the trash no longer holds it; `messages` is emptied at
  -- the same moment to stop carrying the conversation after the decision.
  purged_at timestamptz
);

create index if not exists trash_owner_deleted_idx
  on public.trash (owner, deleted_at desc);

alter table public.folders enable row level security;
alter table public.trash enable row level security;

drop policy if exists folders_owner on public.folders;
create policy folders_owner on public.folders
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists folders_admin on public.folders;
create policy folders_admin on public.folders
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists trash_owner on public.trash;
create policy trash_owner on public.trash
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists trash_admin on public.trash;
create policy trash_admin on public.trash
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.folders to authenticated;
grant select, insert, update, delete on public.trash to authenticated;
