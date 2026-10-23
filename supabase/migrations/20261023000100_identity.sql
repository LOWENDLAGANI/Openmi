-- ── Identity, the visitor registry, push subscriptions, usage ───────────────
--
-- Replaces `users/{uid}/profile`, `admin/registry/{uid}`, `push/subscriptions`,
-- and `usage`. The ownership rules are the same ones the Realtime Database
-- carried, translated line by line:
--
--   * `profiles`       owner reads and writes; replaces `users/$uid/profile`,
--                      which the rules let its owner read.
--   * `visitor_registry` owner writes and never reads; the console reads all.
--                      This is the deliberate asymmetry the old rules had: a
--                      visitor may say who they are, not see who else is here.
--   * `push_subscriptions` owner or administrator, exactly as before.
--   * `usage_daily`    owner reads and writes own rows; administrator reads all.

create table if not exists public.profiles (
  id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text check (name is null or length(name) <= 40),
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.visitor_registry (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  first_seen timestamptz,
  last_seen timestamptz
);

create index if not exists visitor_registry_last_seen_idx
  on public.visitor_registry (last_seen desc);

create table if not exists public.push_subscriptions (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null,
  keys jsonb not null default '{}'::jsonb,
  device_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_daily (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  chat integer not null default 0 check (chat >= 0),
  image integer not null default 0 check (image >= 0),
  auto integer not null default 0 check (auto >= 0),
  code integer not null default 0 check (code >= 0),
  self integer not null default 0 check (self >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner, day)
);

create index if not exists usage_daily_day_idx on public.usage_daily (day desc);

alter table public.profiles enable row level security;
alter table public.visitor_registry enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.usage_daily enable row level security;

drop policy if exists profiles_owner on public.profiles;
create policy profiles_owner on public.profiles
  for all to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists profiles_admin on public.profiles;
create policy profiles_admin on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- The owner may write their own registration and remove it with their data, but
-- has no SELECT: this is `admin/registry` as the old rules had it.
--
-- That asymmetry is why the write goes through a function rather than through a
-- policy. PostgreSQL applies the SELECT policies to the rows an UPDATE or DELETE
-- may touch, so on a table with no SELECT policy for its owner a plain write
-- silently matches nothing — a name would never be registered and never be
-- erased, with no error to show for it. `register_visitor()` and
-- `forget_visitor()` are SECURITY DEFINER, scope themselves to `auth.uid()`, and
-- are the only doors. Nothing can read the table except the administrator.
create or replace function public.register_visitor(
  p_name text,
  p_first_seen timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_name is null or length(btrim(p_name)) = 0 or length(btrim(p_name)) > 40 then
    raise exception 'a name must be 1 to 40 characters';
  end if;

  insert into public.visitor_registry (owner, name, first_seen, last_seen)
  values (auth.uid(), btrim(p_name), coalesce(p_first_seen, now()), now())
  on conflict (owner) do update
    set name = excluded.name,
        last_seen = excluded.last_seen;
end;
$$;

revoke all on function public.register_visitor(text, timestamptz) from public;
grant execute on function public.register_visitor(text, timestamptz) to authenticated;

/**
 * Removes the caller's own registry row, for "delete my data".
 *
 * Same reason as the write above: with no SELECT policy the delete would match
 * nothing. It can only ever remove the caller's own row.
 */
create or replace function public.forget_visitor()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  delete from public.visitor_registry where owner = auth.uid();
end;
$$;

revoke all on function public.forget_visitor() from public;
grant execute on function public.forget_visitor() to authenticated;

drop policy if exists visitor_registry_admin on public.visitor_registry;
create policy visitor_registry_admin on public.visitor_registry
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists push_subscriptions_owner on public.push_subscriptions;
create policy push_subscriptions_owner on public.push_subscriptions
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists push_subscriptions_admin on public.push_subscriptions;
create policy push_subscriptions_admin on public.push_subscriptions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists usage_daily_owner on public.usage_daily;
create policy usage_daily_owner on public.usage_daily
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

drop policy if exists usage_daily_admin on public.usage_daily;
create policy usage_daily_admin on public.usage_daily
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.profiles to authenticated;
-- The registry is the administrator's to read, and reachable for everyone else
-- only through the two functions above. No INSERT/UPDATE/DELETE grant exists, so
-- a direct write is a permission failure rather than a silent no-op.
grant select, delete on public.visitor_registry to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, update, delete on public.usage_daily to authenticated;

/**
 * Counts one use of the day's allowance and answers the counters.
 *
 * The old build did this as a read-modify-write over `usage/$uid/$day`, which
 * two overlapping requests could race: both read 3, both wrote 4, and the cap
 * was exceeded by a silent margin. Postgres can just add. `auth.uid()` is the
 * owner, RLS applies because the function is a plain invoker, and the day is
 * computed in UTC so a cap means the same thing wherever the caller is.
 */
create or replace function public.bump_usage(p_kind text, p_mode text default null)
returns table (chat integer, image integer, auto integer, code integer, self integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  today date := (now() at time zone 'utc')::date;
  mode text := case when p_mode in ('auto', 'code', 'self') then p_mode else null end;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_kind not in ('chat', 'image') then
    raise exception 'unknown usage kind: %', p_kind;
  end if;

  insert into public.usage_daily (owner, day)
  values (auth.uid(), today)
  on conflict (owner, day) do nothing;

  return query
    update public.usage_daily u
       set chat = u.chat + case when p_kind = 'chat' then 1 else 0 end,
           image = u.image + case when p_kind = 'image' then 1 else 0 end,
           auto = u.auto + case when mode = 'auto' then 1 else 0 end,
           code = u.code + case when mode = 'code' then 1 else 0 end,
           self = u.self + case when mode = 'self' then 1 else 0 end,
           updated_at = now()
     where u.owner = auth.uid()
       and u.day = today
    returning u.chat, u.image, u.auto, u.code, u.self;
end;
$$;

revoke all on function public.bump_usage(text, text) from public;
grant execute on function public.bump_usage(text, text) to authenticated;

/**
 * Chat counts and the last activity for every visitor, in one call.
 *
 * The console used to read the whole `users` tree to count messages per person,
 * which meant downloading every message ever written to draw one column. This
 * counts them where they live. It is SECURITY DEFINER because it reads across
 * owners, and it refuses anybody who is not the administrator — the same check
 * the policies make, restated here because a function that bypasses RLS has to
 * carry its own gate.
 */
create or replace function public.admin_user_stats()
returns table (owner uuid, chats bigint, messages bigint, last_chat_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
    select c.owner,
           count(distinct c.id)::bigint as chats,
           count(m.id)::bigint as messages,
           max(greatest(c.updated_at, coalesce(m.created_at, c.updated_at))) as last_chat_at
      from public.chats c
      left join public.chat_messages m on m.chat_id = c.id
     group by c.owner;
end;
$$;

revoke all on function public.admin_user_stats() from public;
grant execute on function public.admin_user_stats() to authenticated;
