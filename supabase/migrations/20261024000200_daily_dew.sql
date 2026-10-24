-- ── The daily free Dew bucket ────────────────────────────────────────────────
--
-- Every account gets a small free allowance each day. It is not a credit: it
-- does not sit in `dew_credits`, it does not survive midnight, and it cannot be
-- saved up. The bucket lives on the wallet row so a charge can spend it and the
-- paid credit in one atomic statement, and so the balance a client reads is
-- still derived from stored numbers rather than from what the client claims.
--
--   daily_day    the day the bucket below belongs to
--   daily_spent  free Dew used that day (0 … 5)
--
-- `spent` keeps its old meaning: paid credit used. It never moves because of
-- free Dew, which is what makes "unused free Dew does not carry over" true
-- without touching anything somebody bought. Midnight is Kuala Lumpur's, the
-- same `DEW_RESET_TIME_ZONE` as lib/dew.ts; the database rolls the bucket over
-- with its own clock so a client cannot choose a day that suits it.
--
-- Applying this migration after the code is safe (the reader falls back to the
-- paid-only wallet), but applying it first is the honest order.

alter table public.dew_wallets
  add column if not exists daily_day date,
  add column if not exists daily_spent numeric(18, 3) not null default 0
    check (daily_spent >= 0);

-- ── The one write path ───────────────────────────────────────────────────────
--
-- Same signature and same guarantees as before: only the caller's own wallet,
-- one statement, no direct column write for `authenticated`. The difference is
-- where the money comes from — free Dew first, then paid credit.
--
-- The row is locked for the duration of the statement (`for update`) so two
-- overlapping requests cannot both spend the last of the free bucket and push
-- the paid charge into a stale total. On a new day the old bucket is discarded
-- before the charge is split, which is the reset.
--
-- A charge larger than the free bucket lands partly in `spent`; the reader
-- floors the paid balance at zero, exactly as before.

create or replace function public.deduct_dew(p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  charged numeric := least(round(greatest(coalesce(p_amount, 0), 0), 3), 100000);
  free_per_day numeric := 5;
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
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

  insert into public.dew_wallets (owner)
  values (auth.uid())
  on conflict (owner) do nothing;

  select * into wallet
  from public.dew_wallets
  where owner = auth.uid()
  for update;

  free_left := case
    when wallet.daily_day is distinct from today then free_per_day
    else greatest(0, free_per_day - wallet.daily_spent)
  end;

  free_charge := least(charged, free_left);
  paid_charge := charged - free_charge;

  update public.dew_wallets
     set spent = spent + paid_charge,
         daily_spent = case
           when daily_day is distinct from today then free_charge
           else daily_spent + free_charge
         end,
         daily_day = today,
         updated_at = now()
   where owner = auth.uid()
  returning spent into total;

  return total;
end;
$$;

revoke all on function public.deduct_dew(numeric) from public;
grant execute on function public.deduct_dew(numeric) to authenticated;

-- The daily columns are readable so the balance can be derived, and writable
-- only through the function above. The select grant from the original migration
-- covers them; no update/insert grant is added here on purpose.
