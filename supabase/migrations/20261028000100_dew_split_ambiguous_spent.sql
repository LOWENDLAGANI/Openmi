-- ── The charge function stops arguing with itself over `spent` ───────────────
--
-- `deduct_dew_split()` is declared `returns table (spent numeric, …)`, and a
-- table column in RETURNS TABLE is a plpgsql OUT parameter — a variable. Inside
-- the function's own UPDATE, the bare name `spent` therefore matched both the
-- wallet column and that variable, and PostgreSQL refuses to guess:
--
--   ERROR: column reference "spent" is ambiguous
--
-- Every charge died there. The routes only log a refused deduction, so the
-- failure was quiet: the balance never moved, the free daily bucket never
-- filled, and `dew_transactions` was never written. Hour sessions failed the
-- same way, because `start_hour_session()` charges through this function.
--
-- This replaces the body from 20261028000000_pricing_sessions.sql with one that
-- names the column it moves and computes the new total from the wallet row it
-- already holds under `for update`. Nothing else changes: same signature, same
-- 10/15 free bucket, same free-before-credit order, same locked statement, same
-- returned column names — `lib/serverDew.ts` reads `spent`, `free_charged` and
-- `paid_charged`, so those names are part of the interface.

create or replace function public.deduct_dew_split(p_amount numeric)
returns table (spent numeric, free_charged numeric, paid_charged numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  charged numeric := least(round(greatest(coalesce(p_amount, 0), 0), 3), 100000);
  free_per_day numeric := case when public.has_paid_pass() then 15 else 10 end;
  account_timezone text;
  today date;
  wallet public.dew_wallets%rowtype;
  total numeric;
  free_left numeric;
  free_amount numeric;
  paid_amount numeric;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if charged <= 0 then
    select w.spent into total from public.dew_wallets w where w.owner = auth.uid();
    return query select coalesce(total, 0), 0::numeric, 0::numeric;
    return;
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

  free_amount := least(charged, free_left);
  paid_amount := charged - free_amount;

  -- The wallet row is locked above, so the spend this charge produces is the
  -- value read there plus the paid half. Computed from `wallet` rather than read
  -- back, because reading it back means naming the column in a RETURNING list,
  -- which is exactly the ambiguity this migration removes.
  total := wallet.spent + paid_amount;

  update public.dew_wallets
     set spent = public.dew_wallets.spent + paid_amount,
         daily_spent = case
           when daily_day is null or daily_day < today then free_amount
           else daily_spent + free_amount
         end,
         daily_day = case
           when daily_day is null or daily_day < today then today
           else daily_day
         end,
         updated_at = now()
   where owner = auth.uid();

  return query select total, free_amount, paid_amount;
end;
$$;

revoke all on function public.deduct_dew_split(numeric) from public;
grant execute on function public.deduct_dew_split(numeric) to authenticated;
