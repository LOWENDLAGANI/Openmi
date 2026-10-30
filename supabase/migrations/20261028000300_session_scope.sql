-- ── The hour is for one model and one repository ────────────────────────────
--
-- An hour used to cover everything: every chat, every model, every repository.
-- That made the cheapest purchase the widest one, and it let a session bought
-- for one model or one repository be spent on another. The hour is now bound to
-- what was bought:
--
--   * `model`      — one of the product's modes ('auto', 'code', 'flash'). Every
--                    request must ask for this model, and `/api/chat` refuses a
--                    different one instead of answering under it.
--   * `project_id` — the repository the hour was started on, or NULL when it was
--                    started in ordinary chat. The agent only runs on this one.
--   * `repo_full_name` — the same repository's `owner/name`, so a refusal can
--                    name it to the person instead of showing an id.
--
-- Changing either is a new purchase, never a toggle: the routes answer with the
-- active model or repository and the choice to keep using it or end the hour.
-- The binding lives in the row, next to the primary key that makes a second
-- hour impossible, because a client-side flag is not a rule.
--
-- `start_hour_session()` keeps its price constant and its one-row-per-account
-- guarantee. It now takes the model and repository to bind, validates both
-- against what this account actually owns, and echoes the active binding in its
-- refusal so the caller never has to guess what the live hour is for.
--
-- Safe to run more than once, and it does not end a live hour: the new columns
-- are added in place, and an hour started before this file reads as `auto` with
-- no repository, which is exactly the scope it was sold as.

alter table public.hour_sessions
  add column if not exists model text not null default 'auto',
  add column if not exists project_id text,
  add column if not exists repo_full_name text;

-- A model name the product does not offer must not be storable. The constraint
-- is added once, so a second run of this file is a no-op rather than an error.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.hour_sessions'::regclass
      and conname = 'hour_sessions_model_allowed'
  ) then
    alter table public.hour_sessions
      add constraint hour_sessions_model_allowed
      check (model in ('auto', 'code', 'flash'));
  end if;
end;
$$;

-- The signature changes, and `create or replace` cannot change one. The no-arg
-- function from 20261028000200_charge_dew.sql is dropped here; the price stays a
-- constant inside the body, exactly as before.
drop function if exists public.start_hour_session();

create function public.start_hour_session(p_model text default 'auto', p_project_id text default null)
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
  chosen_model text := lower(btrim(coalesce(nullif(p_model, ''), 'auto')));
  chosen_project text := nullif(btrim(coalesce(p_project_id, '')), '');
  chosen_repo text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- The model is one of the product's modes. Anything else is not a scope this
  -- function can bind, and an hour bound to nothing would be every model again.
  if chosen_model not in ('auto', 'code', 'flash') then
    raise exception 'That is not a model Openmi offers.' using errcode = '22023';
  end if;

  -- A repository scope must be a project this account actually owns. The route
  -- checks this too; here it is the rule, because this function is callable by
  -- any signed-in account through PostgREST.
  if chosen_project is not null then
    select p.repo_full_name into chosen_repo
    from public.projects p
    where p.owner = auth.uid()
      and p.id = chosen_project;

    if chosen_repo is null then
      chosen_project := null;
      raise exception 'That repository is not attached to this account.' using errcode = '22023';
    end if;
  end if;

  -- One start at a time per account, across every instance.
  perform pg_advisory_xact_lock(hashtextextended('openmi-hour:' || auth.uid()::text, 0));

  select * into active
  from public.hour_sessions
  where owner = auth.uid()
  for update;

  if found and active.ended_at is null and active.expires_at > starts then
    -- The refusal carries the live binding, so the interface can say what the
    -- hour is for instead of only that it exists.
    return jsonb_build_object(
      'ok', false,
      'reason', 'active',
      'price', active.price,
      'model', active.model,
      'project_id', active.project_id,
      'repo_full_name', active.repo_full_name,
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

  insert into public.hour_sessions (owner, started_at, expires_at, ended_at, price, model, project_id, repo_full_name)
  values (auth.uid(), starts, ends, null, price, chosen_model, chosen_project, chosen_repo)
  on conflict (owner) do update
    set started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        ended_at = null,
        price = excluded.price,
        model = excluded.model,
        project_id = excluded.project_id,
        repo_full_name = excluded.repo_full_name;

  return jsonb_build_object(
    'ok', true,
    'price', price,
    'model', chosen_model,
    'project_id', chosen_project,
    'repo_full_name', chosen_repo,
    'expires_at', ends,
    'free_charged', free_charged,
    'paid_charged', paid_charged
  );
end;
$$;

revoke all on function public.start_hour_session(text, text) from public;
grant execute on function public.start_hour_session(text, text) to authenticated;

grant usage on schema public to anon, authenticated;

-- The setup banner resolves `object_name` through to_regprocedure, so the row
-- must name the signature that now exists. The old no-arg entry would otherwise
-- report a function the build no longer has.
delete from public.schema_expected where object_name = 'start_hour_session()';

insert into public.schema_expected (object_name, kind, migration)
values ('start_hour_session(text,text)', 'function', '20261028000300_session_scope')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;

-- PostgREST caches function signatures, and this one gained two arguments.
notify pgrst, 'reload schema';
