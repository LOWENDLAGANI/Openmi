-- ── Chat history and memories ──────────────────────────────────────────────
--
-- Replaces `users/$uid/chats/$chatId` (with its nested `messages` map) and
-- `users/$uid/memory`. The nesting is normalised here because that is the whole
-- point of moving to Postgres: a message is a row you can index, count and
-- scope by owner, not a key inside a document.
--
-- The owner may read and write their own rows. The administrator may read and
-- delete any row, which is what the console's visitor list and wipe buttons did
-- under `database.rules.json`.
--
-- `chat_messages.owner` is denormalised on purpose. The console lists and wipes
-- by owner, and a policy that had to join back to `chats` on every insert would
-- be a policy that could be tricked by a chat id that belongs to somebody else.

create table if not exists public.chats (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'New chat',
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chats_owner_updated_idx
  on public.chats (owner, updated_at desc);

create table if not exists public.chat_messages (
  id text primary key,
  chat_id text not null,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  model text,
  search_query text,
  sources jsonb,
  usage jsonb,
  error text,
  steps jsonb,
  changeset_id text,
  truncated boolean not null default false,
  variants jsonb,
  variant_index integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_messages_chat_idx
  on public.chat_messages (chat_id, created_at);
create index if not exists chat_messages_owner_idx
  on public.chat_messages (owner, created_at desc);

create table if not exists public.memories (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text text not null check (length(text) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists memories_owner_idx on public.memories (owner, created_at desc);

alter table public.chats enable row level security;
alter table public.chat_messages enable row level security;
alter table public.memories enable row level security;

drop policy if exists chats_owner on public.chats;
create policy chats_owner on public.chats
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists chats_admin on public.chats;
create policy chats_admin on public.chats
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists chat_messages_owner on public.chat_messages;
create policy chat_messages_owner on public.chat_messages
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists chat_messages_admin on public.chat_messages;
create policy chat_messages_admin on public.chat_messages
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists memories_owner on public.memories;
create policy memories_owner on public.memories
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists memories_admin on public.memories;
create policy memories_admin on public.memories
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.chats to authenticated;
grant select, insert, update, delete on public.chat_messages to authenticated;
grant select, insert, update, delete on public.memories to authenticated;
