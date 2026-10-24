-- ── The day turns over where the account is ──────────────────────────────────
--
-- The free bucket from 20261024000200_daily_dew.sql turned over in Kuala
-- Lumpur for everybody. This migration gives each account its own midnight: the
-- browser reports its IANA zone the first time the account is seen, the zone is
-- kept on `profiles.timezone`, and `deduct_dew()` reads it when it decides
-- whether the day has changed.
--
-- Three properties are deliberate:
--
--   * The zone is write-once. `set_profile_timezone()` fills an empty column and
--     leaves a filled one alone, so a trip or a second browser cannot move the
--     account's midnight (and cannot be used to collect a bucket early twice).
--   * The database keeps its own clock. It reads `now()` and converts it in the
--     stored zone; the caller never sends a date it could choose.
--   * The bucket only moves forward. A stored day later than today's date — the
--     zone was edited directly, or the clock went backwards — does not refill.
--     Only a day that has actually passed starts a new allotment.
--
-- A profile with no usable zone falls back to Asia/Kuala_Lumpur, the same
-- default as `DEW_RESET_TIME_ZONE` in lib/dew.ts. That is what existing accounts
-- get until their browser reports one, and it is what the database already used
-- for them.

alter table public.profiles
  add column if not exists timezone text;

/**
 * Reports the zone this account was registered in, once.
 *
 * The value comes from the browser, so it is validated against PostgreSQL's own
 * zone list before it is stored; anything else is ignored rather than allowed to
 * make `at time zone` raise on a later charge. The `where` on the conflict
 * clause is the write-once rule: a second report from another device or another
 * country changes nothing.
 *
 * SECURITY DEFINER so the caller never needs write access to the column, which
 * is also what keeps `profiles.timezone` out of the ordinary profile upsert.
 */
create or replace function public.set_profile_timezone(p_timezone text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  zone text := btrim(coalesce(p_timezone, ''));
  stored text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if zone <> '' and exists (select 1 from pg_timezone_names where name = zone) then
    insert into public.profiles (id, timezone)
    values (auth.uid(), zone)
    on conflict (id) do update
      set timezone = excluded.timezone,
          updated_at = now()
      where public.profiles.timezone is null;
  end if;

  select timezone into stored from public.profiles where id = auth.uid();
  return stored;
end;
$$;

revoke all on function public.set_profile_timezone(text) from public;
grant execute on function public.set_profile_timezone(text) to authenticated;

-- ── The one write path, now on the account's clock ───────────────────────────
--
-- Same signature and guarantees as 20261024000200_daily_dew.sql: only the
-- caller's wallet, one statement, free Dew before paid credit, row locked while
-- the split is made. The differences are the source of "today" and the
-- forward-only day comparison described above.

create or replace function public.deduct_dew(p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  charged numeric := least(round(greatest(coalesce(p_amount, 0), 0), 3), 100000);
  free_per_day numeric := 5;
  account_timezone text;
  today date;
  wallet public.dew_wallets%rowtype;
  total numeric;
  free_left numeric;
  free_charge numeric;
  paid_charge numeric;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if charged <= 0 then
    select spent into total from public.dew_wallets where owner = auth.uid();
    return coalesce(total, 0);
  end if;

  select p.timezone into account_timezone
  from public.profiles p
  where p.id = auth.uid();

  if account_timezone is null
     or not exists (select 1 from pg_timezone_names z where z.name = account_timezone) then
    account_timezone := 'Asia/Kuala_Lumpur';
  end if;

  today := (now() at time zone account_timezone)::date;

  insert into public.dew_wallets (owner)
  values (auth.uid())
  on conflict (owner) do nothing;

  select * into wallet
  from public.dew_wallets
  where owner = auth.uid()
  for update;

  free_left := case
    when wallet.daily_day is null or wallet.daily_day < today then free_per_day
    else greatest(0, free_per_day - wallet.daily_spent)
  end;

  free_charge := least(charged, free_left);
  paid_charge := charged - free_charge;

  update public.dew_wallets
     set spent = spent + paid_charge,
         daily_spent = case
           when daily_day is null or daily_day < today then free_charge
           else daily_spent + free_charge
         end,
         daily_day = case
           when daily_day is null or daily_day < today then today
           else daily_day
         end,
         updated_at = now()
   where owner = auth.uid()
  returning spent into total;

  return total;
end;
$$;

revoke all on function public.deduct_dew(numeric) from public;
grant execute on function public.deduct_dew(numeric) to authenticated;

-- `profiles.timezone` is read like any other profile column. Ordinary profile
-- writes still come through the upsert in lib/account.ts and simply do not send
-- this column; the RPC above is the only writer of it.
