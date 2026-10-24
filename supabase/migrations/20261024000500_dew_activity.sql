-- ── What did the free allowance pay for, and what did I buy? ─────────────────
--
-- `dew_transactions` has recorded the price of every request since the ledger
-- was written, but not where that price came from: the daily free bucket or the
-- paid credit. A balance can be derived without that distinction, but a person
-- looking at a spend history cannot — "5 Dew today" is a very different fact
-- under "free" than under "paid".
--
-- So the charge now reports its own split, and the history keeps it. The split
-- is produced by the same function that moves the wallet, inside the same row
-- lock, so the log cannot disagree with the balance because a second request
-- landed between the two writes.
--
--   free_dew  the part paid from today's free bucket
--   paid_dew  the part taken from credits
--   free_dew + paid_dew = dew (the flat price of the request)
--
-- `deduct_dew(numeric)` is kept as a wrapper: it is the name existing code and
-- earlier deployments call, and a new return shape would have required dropping
-- it. `deduct_dew_split(numeric)` is the new door; the server calls it and falls
-- back to the wrapper when this migration has not been applied yet.

alter table public.dew_transactions
  add column if not exists free_dew numeric(18, 3) not null default 0
    check (free_dew >= 0),
  add column if not exists paid_dew numeric(18, 3) not null default 0
    check (paid_dew >= 0);

/**
 * Deducts one request and says how it was paid for.
 *
 * Same guarantees as the previous `deduct_dew()`: only the caller's wallet, the
 * account's own day, free Dew before paid credit, one locked statement. The
 * only change is the answer: the spent total plus the two halves.
 */
create or replace function public.deduct_dew_split(p_amount numeric)
returns table (spent numeric, free_charged numeric, paid_charged numeric)
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

  update public.dew_wallets
     set spent = spent + paid_amount,
         daily_spent = case
           when daily_day is null or daily_day < today then free_amount
           else daily_spent + free_amount
         end,
         daily_day = case
           when daily_day is null or daily_day < today then today
           else daily_day
         end,
         updated_at = now()
   where owner = auth.uid()
  returning spent into total;

  return query select total, free_amount, paid_amount;
end;
$$;

revoke all on function public.deduct_dew_split(numeric) from public;
grant execute on function public.deduct_dew_split(numeric) to authenticated;

/** The compatible door: the same charge, only the spent total back. */
create or replace function public.deduct_dew(p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_spent numeric;
begin
  select d.spent into new_spent
  from public.deduct_dew_split(p_amount) as d;
  return coalesce(new_spent, 0);
end;
$$;

revoke all on function public.deduct_dew(numeric) from public;
grant execute on function public.deduct_dew(numeric) to authenticated;

-- ── The audit learns about the new objects ──────────────────────────────────
--
-- This replaces the function from 20261024000400_schema_health.sql because an
-- audit that does not know about `free_dew` would call a half-applied feature
-- healthy. The list is the same, plus the objects this migration adds.

create or replace function public.openmi_schema_health()
returns table (object_name text, kind text, present boolean, migration text)
language sql
stable
security definer
set search_path = public, pg_catalog, pg_temp
as $$
  select 'app_admin', 'table', to_regclass('public.app_admin') is not null, '20261023000000_init'
  union all
  select 'app_config', 'table', to_regclass('public.app_config') is not null, '20261023000000_init'
  union all
  select 'is_admin()', 'function', to_regprocedure('public.is_admin()') is not null, '20261023000000_init'
  union all
  select 'profiles', 'table', to_regclass('public.profiles') is not null, '20261023000100_identity'
  union all
  select 'visitor_registry', 'table', to_regclass('public.visitor_registry') is not null, '20261023000100_identity'
  union all
  select 'push_subscriptions', 'table', to_regclass('public.push_subscriptions') is not null, '20261023000100_identity'
  union all
  select 'register_visitor(text,timestamptz)', 'function', to_regprocedure('public.register_visitor(text,timestamptz)') is not null, '20261023000100_identity'
  union all
  select 'bump_usage(text,text)', 'function', to_regprocedure('public.bump_usage(text,text)') is not null, '20261023000100_identity'
  union all
  select 'admin_user_stats()', 'function', to_regprocedure('public.admin_user_stats()') is not null, '20261023000100_identity'
  union all
  select 'chats', 'table', to_regclass('public.chats') is not null, '20261023000200_chats'
  union all
  select 'chat_messages', 'table', to_regclass('public.chat_messages') is not null, '20261023000200_chats'
  union all
  select 'memories', 'table', to_regclass('public.memories') is not null, '20261023000200_chats'
  union all
  select 'github_connections', 'table', to_regclass('public.github_connections') is not null, '20261023000300_github_projects'
  union all
  select 'projects', 'table', to_regclass('public.projects') is not null, '20261023000300_github_projects'
  union all
  select 'changesets', 'table', to_regclass('public.changesets') is not null, '20261023000400_changesets'
  union all
  select 'approvals', 'table', to_regclass('public.approvals') is not null, '20261023000400_changesets'
  union all
  select 'commits', 'table', to_regclass('public.commits') is not null, '20261023000400_changesets'
  union all
  select 'redeem_codes', 'table', to_regclass('public.redeem_codes') is not null, '20261023000500_dew_redeem'
  union all
  select 'redeems', 'table', to_regclass('public.redeems') is not null, '20261023000500_dew_redeem'
  union all
  select 'dew_credits', 'table', to_regclass('public.dew_credits') is not null, '20261023000500_dew_redeem'
  union all
  select 'dew_wallets', 'table', to_regclass('public.dew_wallets') is not null, '20261023000500_dew_redeem'
  union all
  select 'dew_transactions', 'table', to_regclass('public.dew_transactions') is not null, '20261023000500_dew_redeem'
  union all
  select 'deduct_dew(numeric)', 'function', to_regprocedure('public.deduct_dew(numeric)') is not null, '20261023000500_dew_redeem'
  union all
  select 'lookup_redeem_code(text)', 'function', to_regprocedure('public.lookup_redeem_code(text)') is not null, '20261023000500_dew_redeem'
  union all
  select 'user_preferences', 'table', to_regclass('public.user_preferences') is not null, '20261024000000_user_preferences'
  union all
  select 'folders', 'table', to_regclass('public.folders') is not null, '20261024000100_folders_trash'
  union all
  select 'trash', 'table', to_regclass('public.trash') is not null, '20261024000100_folders_trash'
  union all
  select 'chats.folder_id', 'column', exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'chats'
      and a.attname = 'folder_id' and a.attnum > 0 and not a.attisdropped
  ), '20261024000100_folders_trash'
  union all
  select 'dew_wallets.daily_day', 'column', exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dew_wallets'
      and a.attname = 'daily_day' and a.attnum > 0 and not a.attisdropped
  ), '20261024000200_daily_dew'
  union all
  select 'dew_wallets.daily_spent', 'column', exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dew_wallets'
      and a.attname = 'daily_spent' and a.attnum > 0 and not a.attisdropped
  ), '20261024000200_daily_dew'
  union all
  select 'profiles.timezone', 'column', exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'profiles'
      and a.attname = 'timezone' and a.attnum > 0 and not a.attisdropped
  ), '20261024000300_dew_timezone'
  union all
  select 'set_profile_timezone(text)', 'function', to_regprocedure('public.set_profile_timezone(text)') is not null, '20261024000300_dew_timezone'
  union all
  select 'dew_transactions.free_dew', 'column', exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dew_transactions'
      and a.attname = 'free_dew' and a.attnum > 0 and not a.attisdropped
  ), '20261024000500_dew_activity'
  union all
  select 'dew_transactions.paid_dew', 'column', exists (
    select 1 from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'dew_transactions'
      and a.attname = 'paid_dew' and a.attnum > 0 and not a.attisdropped
  ), '20261024000500_dew_activity'
  union all
  select 'deduct_dew_split(numeric)', 'function', to_regprocedure('public.deduct_dew_split(numeric)') is not null, '20261024000500_dew_activity'
$$;

revoke all on function public.openmi_schema_health() from public;
grant execute on function public.openmi_schema_health() to anon, authenticated;
