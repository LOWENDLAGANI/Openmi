-- ── Can this database answer the build it is serving? ────────────────────────
--
-- Every failure mode in this app's setup points at the same question: were the
-- migrations applied? A project with the right keys and an empty schema renders
-- the interface, then answers PGRST202 from the admin gate and PGRST204 from
-- the Dew reader, and the owner is left decoding PostgREST.
--
-- `openmi_schema_health()` answers it in one call. It checks that each table,
-- column and function this build depends on exists, and names the migration
-- that creates the missing one. `/api/setup` reads it with the anon key and the
-- About page's setup banner prints the result.
--
-- It is safe to expose anonymously: it reports existence only, never a row and
-- never a value, and it runs SECURITY DEFINER so `information_schema` does not
-- hide the columns it is asking about. It cannot be used to read the tables it
-- names.
--
-- The list is deliberately the load-bearing surface, not every index: a missing
-- index is slow, a missing table or function is broken. `object_name` is what
-- the banner shows; `migration` is what the owner runs.

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
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'chats'
      and a.attname = 'folder_id'
      and a.attnum > 0
      and not a.attisdropped
  ), '20261024000100_folders_trash'
  union all
  select 'dew_wallets.daily_day', 'column', exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'dew_wallets'
      and a.attname = 'daily_day'
      and a.attnum > 0
      and not a.attisdropped
  ), '20261024000200_daily_dew'
  union all
  select 'dew_wallets.daily_spent', 'column', exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'dew_wallets'
      and a.attname = 'daily_spent'
      and a.attnum > 0
      and not a.attisdropped
  ), '20261024000200_daily_dew'
  union all
  select 'profiles.timezone', 'column', exists (
    select 1
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
      and a.attname = 'timezone'
      and a.attnum > 0
      and not a.attisdropped
  ), '20261024000300_dew_timezone'
  union all
  select 'set_profile_timezone(text)', 'function', to_regprocedure('public.set_profile_timezone(text)') is not null, '20261024000300_dew_timezone'
$$;

revoke all on function public.openmi_schema_health() from public;
grant execute on function public.openmi_schema_health() to anon, authenticated;
