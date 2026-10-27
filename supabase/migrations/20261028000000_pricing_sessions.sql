-- ── Paid passes, the paid daily bucket, and sessions bought by the hour ─────
--
-- Three rules move together here, because they are one price list:
--
--   * A free account gets 10 free Dew a day; a paid pass raises that to 15.
--     The bucket itself is unchanged — same column, same midnight, same
--     free-before-credit order — only its size depends on the pass.
--   * A pass is an expiry row in `paid_passes`. It is granted by the owner
--     after a manual payment, which is the same door every other payment in
--     Openmi uses, and it expires on its own. It is not a column on `profiles`
--     because that row is owner-writable.
--   * A one-hour session is a server-owned row, not a client flag. The price is
--     charged inside the same transaction that starts it, one account can hold
--     exactly one at a time, and a second start is refused with the chat that
--     already owns the hour. A browser cannot talk its way past any of that:
--     the chat route only skips the per-request charge when this row says the
--     owner has an unexpired session for that chat.

-- ── The pass lives where the owner cannot write it ─────────────────────────
--
-- A paid pass is deliberately not a column on `profiles`. That table has an
-- owner-writable policy and a table-level UPDATE grant, so a plan column there
-- would be a self-service upgrade: a modified browser could set its own expiry.
-- This table grants the owner SELECT only. The one writer is
-- `admin_grant_plan()`, which re-checks the admin grant inside the database.

create table if not exists public.paid_passes (
  owner uuid primary key references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.paid_passes enable row level security;

drop policy if exists paid_passes_owner on public.paid_passes;
create policy paid_passes_owner on public.paid_passes
  for select to authenticated
  using (owner = auth.uid());

revoke all on public.paid_passes from anon, authenticated;
grant select on public.paid_passes to authenticated;

/**
 * Whether this caller's paid pass is live right now.
 *
 * SECURITY DEFINER only so the charge functions can read the row without asking
 * the caller for anything; it answers about `auth.uid()` and nobody else. No
 * execute grant: it is an internal predicate, not an endpoint.
 */
create or replace function public.has_paid_pass()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.paid_passes
    where owner = auth.uid()
      and expires_at > now()
  );
$$;

revoke all on function public.has_paid_pass() from public;

-- ── The one write path, now sized by the pass ──────────────────────────────
--
-- Same signature and guarantees as 20261024000500_dew_activity.sql: only the
-- caller's wallet, one locked statement, free Dew before paid credit. The only
-- change is `free_per_day`, which is read from the live pass instead of being
-- the constant five.

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

-- ── The hour that belongs to one chat ──────────────────────────────────────
--
-- One row per owner. Replacing it on a new start is what makes "one active
-- session" true by construction: there is nowhere for a second one to live.
-- Reads are owner-scoped; writes only happen through the functions below, so a
-- caller cannot invent an expiry or skip the charge.

create table if not exists public.hour_sessions (
  owner uuid primary key references auth.users (id) on delete cascade,
  chat_id text not null check (char_length(chat_id) between 1 and 200),
  model text not null default 'flash',
  price numeric(18, 3) not null check (price >= 0),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (expires_at > started_at)
);

alter table public.hour_sessions enable row level security;

drop policy if exists hour_sessions_owner on public.hour_sessions;
create policy hour_sessions_owner on public.hour_sessions
  for select to authenticated
  using (owner = auth.uid());

revoke all on public.hour_sessions from anon, authenticated;
grant select on public.hour_sessions to authenticated;

/**
 * Starts one hour for one chat, charging server-side.
 *
 * The advisory lock serialises two starts from the same account, so a pair of
 * double-clicks cannot both see "no active session" and both pay. The wallet is
 * locked before the balance is judged, and the charge is made inside this same
 * transaction, so a refusal rolls back the session row with it.
 *
 * Answers JSON rather than raising for the two expected refusals, because both
 * are things the interface explains with a choice:
 *
 *   { ok: false, reason: "active", chat_id, expires_at }
 *   { ok: false, reason: "insufficient", available }
 *   { ok: true, chat_id, price, expires_at }
 *
 * The price is a constant here, not an argument. It has to be: the function is
 * callable by any signed-in account, so a price in the request would let a
 * caller buy an hour for a thousandth of a Dew. It is the same figure as
 * `DEW_PER_HOUR_SESSION.code` in lib/dew.ts, and the tests pin the pair.
 */
create or replace function public.start_hour_session(p_chat_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  chat text := btrim(coalesce(p_chat_id, ''));
  charged numeric := 2;
  free_per_day numeric := case when public.has_paid_pass() then 15 else 10 end;
  account_timezone text;
  today date;
  wallet public.dew_wallets%rowtype;
  credits_total numeric;
  free_left numeric;
  available numeric;
  active public.hour_sessions%rowtype;
  starts timestamptz := now();
  ends timestamptz;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if chat = '' or char_length(chat) > 200 then
    raise exception 'A session needs a chat.' using errcode = '22023';
  end if;
  if charged <= 0 then
    raise exception 'A session needs a price.' using errcode = '22023';
  end if;

  -- One start at a time per account, across every instance.
  perform pg_advisory_xact_lock(hashtextextended('openmi-hour:' || uid::text, 0));

  select * into active
  from public.hour_sessions
  where owner = uid
  for update;

  if found and active.ended_at is null and active.expires_at > starts then
    return jsonb_build_object(
      'ok', false,
      'reason', 'active',
      'chat_id', active.chat_id,
      'expires_at', active.expires_at
    );
  end if;

  select coalesce(sum(c.amount), 0) into credits_total
  from public.dew_credits c
  where c.owner = uid;

  select p.timezone into account_timezone
  from public.profiles p
  where p.id = uid;

  if account_timezone is null
     or not exists (select 1 from pg_timezone_names z where z.name = account_timezone) then
    account_timezone := 'Asia/Kuala_Lumpur';
  end if;

  today := (starts at time zone account_timezone)::date;

  insert into public.dew_wallets (owner)
  values (uid)
  on conflict (owner) do nothing;

  select * into wallet
  from public.dew_wallets
  where owner = uid
  for update;

  free_left := case
    when wallet.daily_day is null or wallet.daily_day < today then free_per_day
    else greatest(0, free_per_day - wallet.daily_spent)
  end;

  available := credits_total - wallet.spent + free_left;

  if available < charged - 0.0005 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'insufficient',
      'available', round(greatest(available, 0), 3)
    );
  end if;

  -- Charges free Dew first, then paid credit, and reports both halves in the
  -- wallet row this transaction already holds.
  perform public.deduct_dew_split(charged);

  ends := starts + interval '1 hour';

  insert into public.hour_sessions (owner, chat_id, model, price, started_at, expires_at, ended_at)
  values (uid, chat, 'code', charged, starts, ends, null)
  on conflict (owner) do update
    set chat_id = excluded.chat_id,
        model = excluded.model,
        price = excluded.price,
        started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        ended_at = null;

  return jsonb_build_object(
    'ok', true,
    'chat_id', chat,
    'price', charged,
    'expires_at', ends
  );
end;
$$;

revoke all on function public.start_hour_session(text) from public;
grant execute on function public.start_hour_session(text) to authenticated;

/**
 * Ends the caller's live session, if there is one.
 *
 * Ending an expired session is a no-op: it already cannot cover a request, and
 * the next start replaces the row anyway.
 */
create or replace function public.end_hour_session()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update public.hour_sessions
     set ended_at = now()
   where owner = auth.uid()
     and ended_at is null
     and expires_at > now();

  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

revoke all on function public.end_hour_session() from public;
grant execute on function public.end_hour_session() to authenticated;

-- ── The owner activates a pass ─────────────────────────────────────────────
--
-- A manual payment ends with the owner extending the buyer's pass, exactly as a
-- Dew top-up ends with a credit. The check is the existing `is_admin()`, read
-- from the database rather than from anything the caller sends, and extension
-- starts from whichever is later: now, or a pass that has not run out yet.

create or replace function public.admin_grant_plan(p_uid uuid, p_days integer)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  days integer := least(greatest(coalesce(p_days, 0), 1), 366);
  expiry timestamptz;
begin
  if not public.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if p_uid is null or not exists (select 1 from public.profiles p where p.id = p_uid) then
    raise exception 'No such account.' using errcode = '22023';
  end if;

  insert into public.paid_passes (owner, expires_at, updated_at)
  values (p_uid, now() + make_interval(days => days), now())
  on conflict (owner) do update
    set expires_at = greatest(public.paid_passes.expires_at, now())
                     + make_interval(days => days),
        updated_at = now()
  returning expires_at into expiry;

  return expiry;
end;
$$;

revoke all on function public.admin_grant_plan(uuid, integer) from public;
grant execute on function public.admin_grant_plan(uuid, integer) to authenticated;

-- ── The audit can name a pass grant ────────────────────────────────────────
-- The ledger was a closed list of four actions; activating a pass is a fifth.
-- The original check was inline and therefore unnamed, so it is dropped by the
-- name Postgres generated and replaced with a named constraint.

alter table public.admin_audit
  drop constraint if exists admin_audit_action_check;

alter table public.admin_audit
  add constraint admin_audit_action_allowed
  check (action in ('createCode', 'deleteCode', 'toggleCode', 'grantDew', 'grantPlan'));

-- ── The audit learns about the new objects ─────────────────────────────────
--
-- The setup banner groups missing objects by the migration that adds them, so a
-- deployment that skipped this file names it instead of failing a charge later.

insert into public.schema_expected (object_name, kind, migration)
values
  ('paid_passes', 'table', '20261028000000_pricing_sessions'),
  ('has_paid_pass()', 'function', '20261028000000_pricing_sessions'),
  ('hour_sessions', 'table', '20261028000000_pricing_sessions'),
  ('start_hour_session(text)', 'function', '20261028000000_pricing_sessions'),
  ('end_hour_session()', 'function', '20261028000000_pricing_sessions'),
  ('admin_grant_plan(uuid,integer)', 'function', '20261028000000_pricing_sessions')
on conflict (object_name) do nothing;
