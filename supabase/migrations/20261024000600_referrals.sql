-- ── Invite a friend, both get Dew ───────────────────────────────────────────
--
-- Dew is the product's money, which makes a referral both natural and easy to
-- abuse: an account that can mint invitations can mint Dew. The rules here are
-- chosen to make abuse cost more than it earns:
--
--   * one code per account, generated once and never changed;
--   * one claim per account, enforced by `referrals.referred` being the primary
--     key, so an account cannot be referred twice;
--   * no self-referral;
--   * a referrer is limited to ten successful invitations (250 Dew) in total;
--   * the reward is a fixed credit written by the definer, never an amount the
--     claimant names.
--
-- There is no new policy allowing a client to insert a referral or a credit. The
-- two SECURITY DEFINER functions are the only door, and `claim_referral()` does
-- every check in one transaction.
--
-- The migration also moves the schema audit onto a table. `schema_expected` is
-- the list of objects the build needs, and `openmi_schema_health()` reports
-- which are absent. Future migrations add their objects with one INSERT instead
-- of replacing the whole function.

create table if not exists public.referral_codes (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  code text not null unique check (code = upper(code) and length(code) between 6 and 16),
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  referred uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  owner uuid not null references auth.users (id) on delete cascade,
  code text not null,
  created_at timestamptz not null default now(),
  check (referred <> owner)
);

create index if not exists referrals_owner_idx on public.referrals (owner);

alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;

drop policy if exists referral_codes_owner_read on public.referral_codes;
create policy referral_codes_owner_read on public.referral_codes
  for select to authenticated
  using (owner = auth.uid());

drop policy if exists referral_codes_admin on public.referral_codes;
create policy referral_codes_admin on public.referral_codes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists referrals_owner_read on public.referrals;
create policy referrals_owner_read on public.referrals
  for select to authenticated
  using (owner = auth.uid() or referred = auth.uid());

drop policy if exists referrals_admin on public.referrals;
create policy referrals_admin on public.referrals
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.referral_codes to authenticated;
grant select on public.referrals to authenticated;

/**
 * This account's invitation code, created on first ask.
 *
 * The code is a deterministic slice of the account's own uuid, stored so the
 * unique constraint can enforce one code per person. It is not a secret: the
 * point of an invitation code is to be shared. Guessing one only lets somebody
 * volunteer to be referred, which still costs them a real account and still
 * pays the referrer only once.
 */
create or replace function public.ensure_referral_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  generated text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.referral_codes (owner, code)
  values (auth.uid(), upper(substr(md5(auth.uid()::text), 1, 10)))
  on conflict (owner) do nothing;

  select rc.code into generated from public.referral_codes rc where rc.owner = auth.uid();
  return generated;
end;
$$;

revoke all on function public.ensure_referral_code() from public;
grant execute on function public.ensure_referral_code() to authenticated;

/**
 * Claims an invitation for the signed-in account.
 *
 * Returns the two rewards so the interface can say what happened. A refusal is
 * a raised exception with a sentence meant for a person; the database rolls the
 * whole claim back, including any credit already written in the same call.
 *
 * `for update` on the referrer's code row serialises two simultaneous claims
 * from different invitees, so the ten-invitation cap cannot be beaten by a race
 * that both count nine.
 */
create or replace function public.claim_referral(p_code text)
returns table (referrer_reward numeric, referee_reward numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claim_code text := upper(btrim(coalesce(p_code, '')));
  referrer uuid;
  reward numeric := 25;
  invite_limit integer := 10;
  used integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if claim_code = '' then
    raise exception 'Enter the invitation code you were given.' using errcode = '22023';
  end if;

  select rc.owner into referrer
  from public.referral_codes rc
  where rc.code = claim_code;

  if referrer is null then
    raise exception 'That invitation code is not valid.' using errcode = '22023';
  end if;

  if referrer = auth.uid() then
    raise exception 'You cannot use your own invitation code.' using errcode = '22023';
  end if;

  if exists (select 1 from public.referrals r where r.referred = auth.uid()) then
    raise exception 'This account has already used an invitation.' using errcode = '23505';
  end if;

  perform 1 from public.referral_codes rc where rc.owner = referrer for update;

  select count(*) into used from public.referrals r where r.owner = referrer;
  if used >= invite_limit then
    raise exception 'This invitation has reached its limit.' using errcode = '22023';
  end if;

  insert into public.referrals (referred, owner, code)
  values (auth.uid(), referrer, claim_code);

  insert into public.dew_credits (owner, code, amount)
  values (referrer, 'REFERRAL-' || upper(substr(replace(auth.uid()::text, '-', ''), 1, 12)), reward)
  on conflict (owner, code) do nothing;

  insert into public.dew_credits (owner, code, amount)
  values (auth.uid(), 'REFERRAL-WELCOME', reward)
  on conflict (owner, code) do nothing;

  return query select reward, reward;
end;
$$;

revoke all on function public.claim_referral(text) from public;
grant execute on function public.claim_referral(text) to authenticated;

-- ── The audit becomes a table ───────────────────────────────────────────────
--
-- One row per object the build depends on. The function below asks the catalog
-- about each row, so a new migration adds its objects with one INSERT and every
-- deployment reports the same list. RLS is on with no policies: only the
-- SECURITY DEFINER audit reads it, and no client has a grant.

create table if not exists public.schema_expected (
  object_name text primary key,
  kind text not null check (kind in ('table', 'column', 'function')),
  migration text not null
);

alter table public.schema_expected enable row level security;

insert into public.schema_expected (object_name, kind, migration) values
  ('app_admin', 'table', '20261023000000_init'),
  ('app_config', 'table', '20261023000000_init'),
  ('is_admin()', 'function', '20261023000000_init'),
  ('profiles', 'table', '20261023000100_identity'),
  ('visitor_registry', 'table', '20261023000100_identity'),
  ('push_subscriptions', 'table', '20261023000100_identity'),
  ('register_visitor(text,timestamptz)', 'function', '20261023000100_identity'),
  ('bump_usage(text,text)', 'function', '20261023000100_identity'),
  ('admin_user_stats()', 'function', '20261023000100_identity'),
  ('chats', 'table', '20261023000200_chats'),
  ('chat_messages', 'table', '20261023000200_chats'),
  ('memories', 'table', '20261023000200_chats'),
  ('github_connections', 'table', '20261023000300_github_projects'),
  ('projects', 'table', '20261023000300_github_projects'),
  ('changesets', 'table', '20261023000400_changesets'),
  ('approvals', 'table', '20261023000400_changesets'),
  ('commits', 'table', '20261023000400_changesets'),
  ('redeem_codes', 'table', '20261023000500_dew_redeem'),
  ('redeems', 'table', '20261023000500_dew_redeem'),
  ('dew_credits', 'table', '20261023000500_dew_redeem'),
  ('dew_wallets', 'table', '20261023000500_dew_redeem'),
  ('dew_transactions', 'table', '20261023000500_dew_redeem'),
  ('deduct_dew(numeric)', 'function', '20261023000500_dew_redeem'),
  ('lookup_redeem_code(text)', 'function', '20261023000500_dew_redeem'),
  ('user_preferences', 'table', '20261024000000_user_preferences'),
  ('folders', 'table', '20261024000100_folders_trash'),
  ('trash', 'table', '20261024000100_folders_trash'),
  ('chats.folder_id', 'column', '20261024000100_folders_trash'),
  ('dew_wallets.daily_day', 'column', '20261024000200_daily_dew'),
  ('dew_wallets.daily_spent', 'column', '20261024000200_daily_dew'),
  ('profiles.timezone', 'column', '20261024000300_dew_timezone'),
  ('set_profile_timezone(text)', 'function', '20261024000300_dew_timezone'),
  ('dew_transactions.free_dew', 'column', '20261024000500_dew_activity'),
  ('dew_transactions.paid_dew', 'column', '20261024000500_dew_activity'),
  ('deduct_dew_split(numeric)', 'function', '20261024000500_dew_activity'),
  ('referral_codes', 'table', '20261024000600_referrals'),
  ('referrals', 'table', '20261024000600_referrals'),
  ('ensure_referral_code()', 'function', '20261024000600_referrals'),
  ('claim_referral(text)', 'function', '20261024000600_referrals'),
  ('schema_expected', 'table', '20261024000600_referrals')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;

/**
 * Reports every expected object and whether it exists.
 *
 * Table and function names are resolved through `to_regclass`/`to_regprocedure`
 * so a name with a signature works as written in `schema_expected`. A column is
 * `table.column` and is looked up in `pg_attribute`, which is visible regardless
 * of the caller because this runs SECURITY DEFINER. Presence only: no row is
 * read and no value is returned.
 */
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
