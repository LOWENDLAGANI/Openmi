-- ── An hour that produced nothing is given back ─────────────────────────────
--
-- Openmi sells time, so the interesting failure is not a single bad answer — it
-- is an hour that was paid for and then bought nothing. Three ways that happens:
--
--   * the model provider was down, so the first request never got a reply;
--   * the agent step failed before it produced anything;
--   * the buyer started an hour and no prompt was ever sent (the tab closed, the
--     send threw, the browser went away).
--
-- All three are refunded automatically, and the rules live here rather than in
-- the browser because a refund is money. The rail is the same in every case:
--
--   * only the caller's own hour can be refunded;
--   * only once — `refunded_at` is the write-once guard, so a retried request
--     cannot pay twice;
--   * only while `reply_at` is null. Once an answer was produced the hour did
--     what it was sold for, and a later failure in the same hour is not a reason
--     to give the whole hour back;
--   * only within a day of the start, so an old row cannot be replayed later.
--
-- The refund restores the split that was charged. Paid credit goes back to the
-- wallet; free Dew goes back to *today's* bucket and only if the charge was made
-- today, because that bucket is a day's allowance and not a balance that can be
-- carried forward. Refunding free Dew as credit would turn a 10-Dew daily
-- allowance into a permanent wallet, which is exactly the leak this avoids.
--
-- An hour is considered "used" from its first reply. `mark_hour_session_activity`
-- is what records that, called by the two routes that can answer: `/api/chat` and
-- the agent step. It is not something the browser reports.

alter table public.hour_sessions
  add column if not exists free_charged numeric(18, 3) not null default 0,
  add column if not exists paid_charged numeric(18, 3) not null default 0,
  add column if not exists charge_day date,
  add column if not exists prompt_at timestamptz,
  add column if not exists reply_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.hour_sessions'::regclass
      and conname = 'hour_sessions_refund_reason_len'
  ) then
    alter table public.hour_sessions
      add constraint hour_sessions_refund_reason_len
      check (refund_reason is null or char_length(refund_reason) <= 60);
  end if;
end;
$$;

-- ── What the hour actually produced ────────────────────────────────────────
-- One call at the start of the first request and one when it produces an
-- answer. Both are best-effort: a route whose activity write fails must still
-- answer, because the price was already settled at start. The write is scoped to
-- the caller's own live, unrefunded hour, so a caller cannot mark somebody
-- else's hour as used.

create or replace function public.mark_hour_session_activity(p_kind text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  kind text := lower(btrim(coalesce(p_kind, '')));
  changed integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if kind not in ('prompt', 'reply') then
    raise exception 'unknown activity' using errcode = '22023';
  end if;

  update public.hour_sessions
     set prompt_at = case when kind = 'prompt' then coalesce(prompt_at, now()) else prompt_at end,
         reply_at = case when kind = 'reply' then coalesce(reply_at, now()) else reply_at end
   where owner = auth.uid()
     and ended_at is null
     and refunded_at is null
     and expires_at > now();

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

revoke all on function public.mark_hour_session_activity(text) from public;
grant execute on function public.mark_hour_session_activity(text) to authenticated;

-- ── The refund itself ──────────────────────────────────────────────────────
-- Returns JSON so the caller can tell the difference between "given back",
-- "already used", "already refunded" and "nothing to refund" — four outcomes
-- that all look like success if only a boolean is returned.

create or replace function public.refund_hour_session(p_reason text default 'failed')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  row public.hour_sessions%rowtype;
  account_timezone text;
  today date;
  restored_paid numeric := 0;
  restored_free numeric := 0;
  free_after numeric;
  reason text := left(coalesce(nullif(btrim(p_reason), ''), 'failed'), 60);
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into row
  from public.hour_sessions
  where owner = uid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  if row.refunded_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already-refunded');
  end if;
  if row.price <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing-charged');
  end if;

  -- The one rail that matters: an hour that produced an answer was used, even
  -- if a later request in it failed.
  if row.reply_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;

  if row.started_at < now() - interval '24 hours' then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;

  if row.paid_charged > 0 then
    update public.dew_wallets
       set spent = greatest(0, spent - row.paid_charged),
           updated_at = now()
     where owner = uid;
    restored_paid := row.paid_charged;
  end if;

  if row.free_charged > 0 then
    select p.timezone into account_timezone
    from public.profiles p
    where p.id = uid;

    if account_timezone is null
       or not exists (select 1 from pg_timezone_names z where z.name = account_timezone) then
      account_timezone := 'Asia/Kuala_Lumpur';
    end if;

    today := (now() at time zone account_timezone)::date;

    -- Free Dew belongs to a day. Returning it on a later day would carry it
    -- forward, which the bucket deliberately never does.
    if row.charge_day is not null and row.charge_day = today then
      update public.dew_wallets w
         set daily_spent = greatest(0, w.daily_spent - row.free_charged),
             updated_at = now()
       where w.owner = uid
         and w.daily_day = today
      returning w.daily_spent into free_after;
      if free_after is not null then
        restored_free := row.free_charged;
      end if;
    end if;
  end if;

  -- Ending it here is part of the refund: an hour that was given back must not
  -- keep covering requests while it is being paid for again.
  update public.hour_sessions
     set ended_at = now(),
         refunded_at = now(),
         refund_reason = reason
   where owner = uid;

  return jsonb_build_object(
    'ok', true,
    'price', row.price,
    'paid', restored_paid,
    'free', restored_free,
    'refunded', restored_paid + restored_free,
    'reason', reason
  );
end;
$$;

revoke all on function public.refund_hour_session(text) from public;
grant execute on function public.refund_hour_session(text) to authenticated;

-- ── The hour nobody ever used ──────────────────────────────────────────────
-- A tab closed between "start" and the first prompt leaves a paid hour with no
-- way to know the buyer meant to come back. Ten minutes is long enough for a
-- slow composer, short enough that somebody who comes back to a fresh page is
-- not charged for a message they never sent. It only ever fires when no prompt
-- was recorded: a prompt that got no reply is the routes' failure to refund (and
-- the client asks for it explicitly), not something a clock may decide.

create or replace function public.auto_refund_idle_hour()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  row public.hour_sessions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into row
  from public.hour_sessions
  where owner = auth.uid();

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  if row.refunded_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already-refunded');
  end if;

  -- A prompt was sent (or an answer came back), so this is not an abandoned
  -- purchase: it is somebody's hour, and the rules above decide about it.
  if row.prompt_at is not null or row.reply_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'used');
  end if;

  if row.started_at > now() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'waiting');
  end if;

  return public.refund_hour_session('no-prompt');
end;
$$;

revoke all on function public.auto_refund_idle_hour() from public;
grant execute on function public.auto_refund_idle_hour() to authenticated;

-- ── The start records the split, and closes an unused predecessor ──────────
-- `start_hour_session` already refused to replace a live hour. It never said
-- anything about an hour that had died without being used, so buying again
-- silently paid twice. Before charging, an existing row that is no longer live
-- is offered to the refund function; that function refuses when it was used, so
-- this cannot turn a spent hour into a free one. The new row then records the
-- exact free/paid split and the day it was charged, which is what makes the
-- refund arithmetic possible at all.

create or replace function public.start_hour_session(p_model text default 'auto', p_project_id text default null)
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

  if chosen_model not in ('auto', 'code', 'flash') then
    raise exception 'That is not a model Openmi offers.' using errcode = '22023';
  end if;

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
      'model', active.model,
      'project_id', active.project_id,
      'repo_full_name', active.repo_full_name,
      'expires_at', active.expires_at
    );
  end if;

  -- A dead row is refunded before this purchase, so an hour that never got a
  -- prompt is not paid for twice. The function itself refuses a used hour.
  if found and active.refunded_at is null then
    perform public.refund_hour_session('unused-before-restart');
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

  insert into public.hour_sessions (
    owner, started_at, expires_at, ended_at, price, model, project_id, repo_full_name,
    free_charged, paid_charged, charge_day, prompt_at, reply_at, refunded_at, refund_reason
  )
  values (
    auth.uid(), starts, ends, null, price, chosen_model, chosen_project, chosen_repo,
    free_charged, paid_charged, today, null, null, null, null
  )
  on conflict (owner) do update
    set started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        ended_at = null,
        price = excluded.price,
        model = excluded.model,
        project_id = excluded.project_id,
        repo_full_name = excluded.repo_full_name,
        free_charged = excluded.free_charged,
        paid_charged = excluded.paid_charged,
        charge_day = excluded.charge_day,
        prompt_at = null,
        reply_at = null,
        refunded_at = null,
        refund_reason = null;

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

insert into public.schema_expected (object_name, kind, migration)
values
  ('refund_hour_session(text)', 'function', '20261029000300_hour_refunds'),
  ('auto_refund_idle_hour()', 'function', '20261029000300_hour_refunds'),
  ('mark_hour_session_activity(text)', 'function', '20261029000300_hour_refunds')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;

notify pgrst, 'reload schema';
