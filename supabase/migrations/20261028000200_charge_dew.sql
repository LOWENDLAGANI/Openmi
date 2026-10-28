-- ── The only charge function ────────────────────────────────────────────────
--
-- By now the charge had been declared four times: `deduct_dew`,
-- `deduct_dew_split`, a patched second copy of `deduct_dew_split`, and a jsonb
-- `dew_charge`. The copies are what broke charging. `deduct_dew_split` was
-- declared `returns table (spent numeric, …)`, and a RETURNS TABLE column is a
-- plpgsql variable — so its own `set spent = spent + …` matched both a variable
-- and a wallet column, PostgreSQL refused to guess, and every charge died with:
--
--   ERROR: column reference "spent" is ambiguous
--
-- Because the routes only log a refused deduction, the failure was quiet: no
-- paid spend, no free bucket use, no history row, and hour sessions for free.
--
-- This file deletes the copies instead of adding a fifth. What is left is one
-- function that takes a price and answers the new paid spend as a plain number:
--
--   select public.deduct_dew_split(0.5);   -- 0.500, or 0 when the free bucket paid
--
-- A numeric answer declares no OUT parameter, so there is nothing left for a
-- column name to collide with — now or in any later edit of this body.
--
-- The name is historical: `start_hour_session()` already calls it, so it keeps
-- its name and its one argument. The charge itself is unchanged and still one
-- locked statement — the caller's own wallet only, today's free bucket first
-- (10 free, 15 with a paid pass, reset in the account's timezone), paid credit
-- after it, and the bucket moved in the same row update.
--
-- The free/paid split is no longer computed here. The caller knows the price and
-- the total it read beforehand, and the wallet only moves by the paid half, so
-- the split is arithmetic instead of a second return shape.
--
-- The function is dropped before it is created because its return type changes,
-- which `create or replace` cannot do. Safe to run more than once.

drop function if exists public.dew_charge(numeric);
drop function if exists public.deduct_dew_split(numeric);
drop function if exists public.deduct_dew(numeric);

create function public.deduct_dew_split(p_amount numeric)
returns numeric
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
  free_left numeric;
  free_amount numeric;
  paid_amount numeric;
  total numeric;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- A charge of nothing is not a failure: it reports the wallet as it stands,
  -- so a caller can read the total without moving it.
  if charged <= 0 then
    select w.spent into total
    from public.dew_wallets w
    where w.owner = auth.uid();
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

  -- The lock is what keeps two overlapping requests from both spending the last
  -- of the free bucket.
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

  -- Read from the locked row rather than a RETURNING list: the row already
  -- holds the pre-charge value, so the new total is that plus the paid half.
  total := wallet.spent + paid_amount;

  update public.dew_wallets w
     set spent = w.spent + paid_amount,
         daily_spent = case
           when w.daily_day is null or w.daily_day < today then free_amount
           else w.daily_spent + free_amount
         end,
         daily_day = case
           when w.daily_day is null or w.daily_day < today then today
           else w.daily_day
         end,
         updated_at = now()
   where w.owner = auth.uid();

  return total;
end;
$$;

revoke all on function public.deduct_dew_split(numeric) from public;
grant execute on function public.deduct_dew_split(numeric) to authenticated;

-- The setup banner is driven by this table: it must stop looking for the
-- functions this file removed, or it would report a gap no migration can close.
delete from public.schema_expected
where object_name in ('deduct_dew(numeric)', 'dew_charge(numeric)');

-- PostgREST caches function signatures, and the one just changed, so tell it to
-- look again instead of serving the old shape.
notify pgrst, 'reload schema';
