-- ── One charge: three Dew buys an hour ──────────────────────────────────────
--
-- Openmi no longer charges for a message. The only thing that costs Dew is an
-- hour of usage, and one hour covers every answer in every chat, on every model.
-- That leaves one price, one function, and one place the wallet can move.
--
-- This replaces the whole earlier stack — `deduct_dew`, `deduct_dew_split`,
-- `dew_charge`, and the old chat-scoped `start_hour_session(text)`. Those are
-- dropped rather than kept as a second way in, because a duplicate door is what
-- made charging fail before: one copy declared `returns table (spent numeric, …)`,
-- whose columns are plpgsql variables, and its own `set spent = spent + …` died
-- with `column reference "spent" is ambiguous`. Every charge aborted and nobody
-- was billed. One function cannot disagree with itself.
--
-- `start_hour_session()` charges its own constant — it takes no price, because a
-- signed-in account can call this RPC directly and a price in the call would let
-- it buy an hour for a thousandth of a Dew. The hour is one row per account and
-- the primary key is what makes a second one impossible; the advisory lock makes
-- two simultaneous starts serialise instead of both seeing "no active session".
--
-- The free daily bucket still pays first: 10 Dew a day (15 with a paid pass), so
-- three hours a day cost nothing, and paid credit covers the rest.
--
-- Safe to run more than once. It is also standalone: it recreates the pass check
-- and the wallet columns it needs if an earlier migration was skipped.

drop function if exists public.dew_charge(numeric);
drop function if exists public.deduct_dew_split(numeric);
drop function if exists public.deduct_dew(numeric);
drop function if exists public.start_hour_session(text);
drop function if exists public.start_hour_session();

-- A session lives at most an hour, so reshaping the table costs at most the hour
-- somebody was in. The drop only happens when the table still has the old
-- per-chat shape, so running this file twice does not end a live hour.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'hour_sessions'
      and column_name = 'chat_id'
  ) then
    drop table public.hour_sessions;
  end if;
end;
$$;

create table if not exists public.hour_sessions (
  owner uuid primary key references auth.users (id) on delete cascade,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  price numeric(18, 3) not null check (price >= 0),
  check (expires_at > started_at)
);

alter table public.hour_sessions enable row level security;

drop policy if exists hour_sessions_owner on public.hour_sessions;
create policy hour_sessions_owner on public.hour_sessions
  for select to authenticated
  using (owner = auth.uid());

revoke all on public.hour_sessions from anon, authenticated;
grant select on public.hour_sessions to authenticated;

-- ── What the hour costs, and what a pass does ──────────────────────────────
--
-- The pass is worth one thing now: a bigger free bucket, 15 instead of 10, which
-- is five hours a day instead of three. Its table is created here so this file
-- does not depend on a migration being applied first.

create table if not exists public.paid_passes (
  owner uuid primary key references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.paid_passes enable row level security;

drop policy if exists paid_passes_owner on public.paid_passes;
create policy paid_passes_owner on public.paid_passes
  for select to authenticated
  using (owner = auth.uid());

revoke all on public.paid_passes from anon, authenticated;
grant select on public.paid_passes to authenticated;

create or replace function public.has_paid_pass()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  live boolean;
begin
  select exists (
    select 1 from public.paid_passes p
    where p.owner = auth.uid() and p.expires_at > now()
  ) into live;
  return coalesce(live, false);
end;
$$;

revoke all on function public.has_paid_pass() from public;

-- The bucket columns arrive with the daily-Dew migration; adding them here keeps
-- this file runnable on a project that skipped it. Both are no-ops when present.
alter table public.dew_wallets
  add column if not exists daily_day date,
  add column if not exists daily_spent numeric(18, 3) not null default 0
    check (daily_spent >= 0),
  add column if not exists updated_at timestamptz not null default now();

-- ── The one charge ─────────────────────────────────────────────────────────
--
-- Answers JSON rather than raising for the two expected refusals, because both
-- are things the interface explains with a choice:
--
--   { ok: false, reason: "active", expires_at }
--   { ok: false, reason: "insufficient", available, price }
--   { ok: true, price, expires_at, free_charged, paid_charged }
--
-- A jsonb answer also declares no OUT parameter, so no variable here can ever
-- collide with a wallet column the way the old table-returning bodies did.

create function public.start_hour_session()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  price numeric := 3;
  free_per_day numeric := case when public.has_paid_pass() then 15 else 10 end;
  account_timezone text;
  today date;
  wallet public.dew_wallets%rowtype;
  credits_total numeric;
  free_left numeric;
  available numeric;
  free_charged numeric;
  paid_charged numeric;
  active public.hour_sessions%rowtype;
  starts timestamptz := now();
  ends timestamptz;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- One start at a time per account, across every instance.
  perform pg_advisory_xact_lock(hashtextextended('openmi-hour:' || auth.uid()::text, 0));

  select * into active
  from public.hour_sessions
  where owner = auth.uid()
  for update;

  if found and active.ended_at is null and active.expires_at > starts then
    return jsonb_build_object(
      'ok', false,
      'reason', 'active',
      'price', active.price,
      'expires_at', active.expires_at
    );
  end if;

  select coalesce(sum(c.amount), 0) into credits_total
  from public.dew_credits c
  where c.owner = auth.uid();

  select p.timezone into account_timezone
  from public.profiles p
  where p.id = auth.uid();

  if account_timezone is null
     or not exists (select 1 from pg_timezone_names z where z.name = account_timezone) then
    account_timezone := 'Asia/Kuala_Lumpur';
  end if;

  today := (starts at time zone account_timezone)::date;

  insert into public.dew_wallets (owner)
  values (auth.uid())
  on conflict (owner) do nothing;

  -- The lock is what keeps two overlapping starts from both spending the last of
  -- the free bucket.
  select * into wallet
  from public.dew_wallets
  where owner = auth.uid()
  for update;

  free_left := case
    when wallet.daily_day is null or wallet.daily_day < today then free_per_day
    else greatest(0, free_per_day - wallet.daily_spent)
  end;

  available := credits_total - wallet.spent + free_left;

  if available < price - 0.0005 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'insufficient',
      'price', price,
      'available', round(greatest(available, 0), 3)
    );
  end if;

  -- Free Dew first, paid credit after it, both in the row this transaction holds.
  free_charged := least(price, free_left);
  paid_charged := price - free_charged;

  update public.dew_wallets w
     set spent = w.spent + paid_charged,
         daily_spent = case
           when w.daily_day is null or w.daily_day < today then free_charged
           else w.daily_spent + free_charged
         end,
         daily_day = case
           when w.daily_day is null or w.daily_day < today then today
           else w.daily_day
         end,
         updated_at = now()
   where w.owner = auth.uid();

  ends := starts + interval '1 hour';

  insert into public.hour_sessions (owner, started_at, expires_at, ended_at, price)
  values (auth.uid(), starts, ends, null, price)
  on conflict (owner) do update
    set started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        ended_at = null,
        price = excluded.price;

  return jsonb_build_object(
    'ok', true,
    'price', price,
    'expires_at', ends,
    'free_charged', free_charged,
    'paid_charged', paid_charged
  );
end;
$$;

revoke all on function public.start_hour_session() from public;
grant execute on function public.start_hour_session() to authenticated;

/**
 * Ends the caller's live hour, if there is one.
 *
 * Ending an expired hour is a no-op: it already cannot cover a request, and the
 * next start replaces the row anyway. No Dew moves here — the hour was charged
 * when it started.
 */
create or replace function public.end_hour_session()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update public.hour_sessions
     set ended_at = now()
   where owner = auth.uid()
     and ended_at is null
     and expires_at > now();

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

revoke all on function public.end_hour_session() from public;
grant execute on function public.end_hour_session() to authenticated;

-- Executing a function also needs USAGE on the schema that holds it. Supabase's
-- starter project grants that; a project created after the public-schema
-- hardening does not, and then even a correct charge is refused with
--   42501: permission denied for schema public
grant usage on schema public to anon, authenticated;

-- The setup banner is driven by this table: it must stop looking for the charge
-- functions this file removed, or it would report a gap no migration can close.
delete from public.schema_expected
where object_name in (
  'deduct_dew(numeric)',
  'deduct_dew_split(numeric)',
  'dew_charge(numeric)',
  'start_hour_session(text)'
);

insert into public.schema_expected (object_name, kind, migration)
values
  ('hour_sessions', 'table', '20261028000200_charge_dew'),
  ('start_hour_session()', 'function', '20261028000200_charge_dew'),
  ('end_hour_session()', 'function', '20261028000200_charge_dew')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;

-- PostgREST caches function signatures, and `start_hour_session` now takes no
-- argument at all.
notify pgrst, 'reload schema';
