-- ── One charge function, with no OUT parameter to argue with ────────────────
--
-- Two migrations now carry a copy of `deduct_dew_split()`, and both of them
-- increment a column called `spent` from inside a function declared
-- `returns table (spent numeric, …)`. A RETURNS TABLE column is a plpgsql OUT
-- parameter — a variable — so inside the function's own UPDATE the bare name
-- `spent` matched both the wallet column and that variable, and PostgreSQL
-- refused to guess:
--
--   ERROR: column reference "spent" is ambiguous
--
-- Every charge died there. The routes only log a refused deduction, so the
-- failure was quiet: the balance never moved, the free daily bucket never
-- filled, and no `dew_transactions` row was ever written.
--
-- 20261028000100 patched one copy of that body by qualifying the column. This
-- file removes the pattern instead of the symptom, because a qualified column is
-- still something a later edit can un-qualify.
--
-- The one real implementation is now `dew_charge(numeric)`, and it returns
-- **jsonb**. A jsonb function has no OUT parameters, so there is no variable
-- named `spent` (or anything else) in scope for a column reference to collide
-- with, and no future edit of this body can recreate the ambiguity. Everything
-- else about the charge is unchanged:
--
--   * only the caller's own wallet, keyed by `auth.uid()`
--   * the wallet row is locked (`for update`) for the length of the split, so
--     two overlapping requests cannot both spend the last free Dew
--   * today's free bucket is spent before paid credit, 10 free / 15 with a pass
--   * the bucket resets on a later day in the account's own timezone
--   * the new total is computed from the locked row, never read back
--
--   { "spent": 12.375, "free_charged": 2, "paid_charged": 0.5 }
--
-- `deduct_dew_split()` and `deduct_dew()` stay as the doors older code calls,
-- now thin wrappers that only read that jsonb — they contain no column
-- reference at all, so the two of them cannot regress either.
--
-- Apply this one file and the charge works, whichever of
-- 20261024000200 / 20261024000500 / 20261028000000 / 20261028000100 a project
-- actually has: it replaces the body wherever the shape came from, and it is
-- safe to run twice.

create or replace function public.dew_charge(p_amount numeric)
returns jsonb
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

  -- A charge of nothing is not a failure: it reports the wallet as it stands.
  -- `w.spent` is qualified because this function also declares a local
  -- `wallet`, and an unqualified name in a query is exactly what PostgreSQL
  -- refuses to guess about.
  if charged <= 0 then
    select w.spent into total
    from public.dew_wallets w
    where w.owner = auth.uid();
    return jsonb_build_object(
      'spent', coalesce(total, 0),
      'free_charged', 0,
      'paid_charged', 0
    );
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

  -- The lock is what makes the split safe: the free bucket is read, judged and
  -- spent while no other charge can see the same leftover.
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

  -- Read from the locked row, not from a RETURNING list: the row already holds
  -- the pre-charge value, so the new total is simply this charge's paid half
  -- added to it.
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

  return jsonb_build_object(
    'spent', total,
    'free_charged', free_amount,
    'paid_charged', paid_amount
  );
end;
$$;

revoke all on function public.dew_charge(numeric) from public;
grant execute on function public.dew_charge(numeric) to authenticated;

-- ── The old doors, now wrappers ─────────────────────────────────────────────
--
-- Same signatures and same answers as before, so `lib/serverDew.ts` and
-- `start_hour_session()` keep working without being changed. Neither body
-- mentions a wallet column, which is the whole point: there is nothing left in
-- them for an OUT parameter to be ambiguous with.

create or replace function public.deduct_dew_split(p_amount numeric)
returns table (spent numeric, free_charged numeric, paid_charged numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  answer jsonb := public.dew_charge(p_amount);
begin
  spent := coalesce((answer ->> 'spent')::numeric, 0);
  free_charged := coalesce((answer ->> 'free_charged')::numeric, 0);
  paid_charged := coalesce((answer ->> 'paid_charged')::numeric, 0);
  return next;
end;
$$;

revoke all on function public.deduct_dew_split(numeric) from public;
grant execute on function public.deduct_dew_split(numeric) to authenticated;

create or replace function public.deduct_dew(p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  answer jsonb := public.dew_charge(p_amount);
begin
  return coalesce((answer ->> 'spent')::numeric, 0);
end;
$$;

revoke all on function public.deduct_dew(numeric) from public;
grant execute on function public.deduct_dew(numeric) to authenticated;

-- ── The audit learns about the one real door ────────────────────────────────
--
-- The setup banner groups missing objects by the migration that adds them, so a
-- deployment that skipped this file names it instead of quietly serving requests
-- for free.

insert into public.schema_expected (object_name, kind, migration)
values ('dew_charge(numeric)', 'function', '20261028000200_charge_dew')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;
