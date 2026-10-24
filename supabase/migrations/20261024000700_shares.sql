-- ── An answer somebody can send to a friend ─────────────────────────────────
--
-- Sharing is a snapshot, not a live view of a chat: the messages are copied into
-- `shared_chats` at the moment the person presses Share, so editing or deleting
-- the conversation later cannot change what the link shows. The link is
-- unguessable, expires after thirty days, and can be revoked.
--
-- Two properties are the reason for the shape below:
--
--   1. The owner's uid never reaches a reader. Anonymous readers use
--      `shared_public`, a view with no owner column, filtered to live rows. They
--      have no grant on the base table, so the id, title and messages are all
--      they can see.
--   2. Revocation is immediate. The view evaluates `revoked = false` and
--      `expires_at > now()` on every read; the server route also answers
--      `cache-control: no-store`, so a stale link cannot outlive its row.
--
-- Rows are deleted with the account. The snapshot itself is plain JSON, bounded
-- in the table's check constraints and validated again in lib/share.ts.

create table if not exists public.shared_chats (
  id text primary key check (id ~ '^[a-z0-9]{16,64}$'),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'Shared answer' check (char_length(title) between 1 and 120),
  messages jsonb not null check (
    jsonb_typeof(messages) = 'array'
    and octet_length(messages::text) <= 400000
  ),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  revoked boolean not null default false
);

create index if not exists shared_chats_owner_idx
  on public.shared_chats (owner, created_at desc);

alter table public.shared_chats enable row level security;

drop policy if exists shared_chats_owner on public.shared_chats;
create policy shared_chats_owner on public.shared_chats
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists shared_chats_admin on public.shared_chats;
create policy shared_chats_admin on public.shared_chats
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.shared_chats to authenticated;

-- The reader's door. It deliberately has no `owner` and no `revoked` column:
-- an anonymous visitor learns the answer, the title and when the link dies, and
-- nothing about whose account it came from.
create or replace view public.shared_public
with (security_invoker = false)
as
  select id, title, messages, created_at, expires_at
  from public.shared_chats
  where not revoked
    and expires_at > now();

revoke all on public.shared_public from public;
grant select on public.shared_public to anon, authenticated;

-- ── The audit learns about views ────────────────────────────────────────────
--
-- `shared_public` is a view, so `schema_expected` gains a view kind and the
-- health function treats it like a table when it asks the catalog. The function
-- is short because the list lives in the table (see 20261024000600_referrals).

alter table public.schema_expected
  drop constraint if exists schema_expected_kind_check;

alter table public.schema_expected
  add constraint schema_expected_kind_check
  check (kind in ('table', 'view', 'column', 'function'));

insert into public.schema_expected (object_name, kind, migration) values
  ('shared_chats', 'table', '20261024000700_shares'),
  ('shared_public', 'view', '20261024000700_shares')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;

create or replace function public.openmi_schema_health()
returns table (object_name text, kind text, present boolean, migration text)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  select
    e.object_name,
    e.kind,
    case e.kind
      when 'table' then to_regclass('public.' || e.object_name) is not null
      when 'view' then to_regclass('public.' || e.object_name) is not null
      when 'function' then to_regprocedure('public.' || e.object_name) is not null
      when 'column' then exists (
        select 1
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = split_part(e.object_name, '.', 1)
          and a.attname = split_part(e.object_name, '.', 2)
          and a.attnum > 0
          and not a.attisdropped
      )
      else false
    end,
    e.migration
  from public.schema_expected e
  order by e.migration, e.object_name;
$$;

revoke all on function public.openmi_schema_health() from public;
grant execute on function public.openmi_schema_health() to anon, authenticated;
