-- ── Dew, redeem codes, and the rules that make them worth money ─────────────
--
-- Replaces `dew/$uid` (with `credits`, `spent` and `tx`), `codes/$code`, and
-- `redeems/$uid/$code`.
--
-- The interesting part of this file is not the tables, it is the four functions
-- at the bottom. `database.rules.json` could validate a write against another
-- branch of the tree, which is exactly how a claim was prevented from naming
-- its own price:
--
--   * a credit may only be written for the trial amount under `TRIAL`, or for
--     exactly the amount a live code carries — never an amount the claimant
--     chose;
--   * a credit is write-once per key, so a replayed claim cannot stack;
--   * `spent` only ever goes up, and only through `deduct_dew()`.
--
-- Postgres can express the same checks, but a policy cannot read a table the
-- caller has no SELECT on, and it cannot be allowed to read the table it is
-- guarding (that recursion is rejected). So the three cross-table checks live
-- in SECURITY DEFINER functions with a pinned search_path, and the policies call
-- them. The tree is still the only judge; the judge just calls a helper.

create table if not exists public.redeem_codes (
  code text primary key,
  dew numeric(18, 3) not null check (dew > 0 and dew <= 100000),
  active boolean not null default true,
  note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.redeems (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  code text not null,
  claimed_at timestamptz not null default now(),
  primary key (owner, code)
);

create table if not exists public.dew_credits (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  code text not null check (code = upper(code) and length(code) between 1 and 40),
  amount numeric(18, 3) not null check (amount > 0 and amount <= 100000),
  created_at timestamptz not null default now(),
  primary key (owner, code)
);

create table if not exists public.dew_wallets (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  spent numeric(18, 3) not null default 0 check (spent >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.dew_transactions (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type text not null default 'usage' check (type = 'usage'),
  at timestamptz not null default now(),
  dew numeric(18, 3) not null check (dew > 0),
  model text,
  prompt integer,
  completion integer,
  repo text
);

create index if not exists dew_transactions_owner_at_idx
  on public.dew_transactions (owner, at desc);

-- ── The cross-table checks ──────────────────────────────────────────────────

/**
 * Whether a live code with this word is worth exactly this amount.
 *
 * SECURITY DEFINER because `redeem_codes` is readable only by the administrator
 * — the same grant `database.rules.json` made. Without this the policy would run
 * as a visitor, see no code, and refuse every legitimate claim.
 */
create or replace function public.redeem_code_value(p_code text)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select dew from public.redeem_codes where code = upper(p_code) and active;
$$;

revoke all on function public.redeem_code_value(text) from public;
grant execute on function public.redeem_code_value(text) to authenticated;

/**
 * The write-time validation the redeems node used to carry.
 *
 * A claim exists only for a code that is live at the moment it is written, and
 * the amount is never part of the claim. Termination is still enforced again on
 * every request that resolves a claim into Dew, so a code switched off *after*
 * it was claimed stops paying out as well — one check without the other leaves
 * the hole that file warns about.
 */
create or replace function public.redeem_code_is_live(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select active from public.redeem_codes where code = upper(p_code)), false);
$$;

revoke all on function public.redeem_code_is_live(text) from public;
grant execute on function public.redeem_code_is_live(text) to authenticated;

/**
 * What a credit write is allowed to be worth.
 *
 * `TRIAL` is the one-time grant, pinned to the same 25 as `TRIAL_DEW` in
 * lib/dew.ts. Every other key must name a live code whose own amount matches, so
 * a modified client that writes `dew: 1000` against a 100-Dew code is refused by
 * the database rather than believed.
 */
create or replace function public.dew_credit_allowed(p_code text, p_amount numeric)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when upper(p_code) = 'TRIAL' then p_amount = 25
    else exists (
      select 1
      from public.redeem_codes c
      where c.code = upper(p_code)
        and c.active
        and c.dew = p_amount
    )
  end;
$$;

revoke all on function public.dew_credit_allowed(text, numeric) from public;
grant execute on function public.dew_credit_allowed(text, numeric) to authenticated;

/**
 * Adds one charge to the caller's own spend and returns the new total.
 *
 * This is the whole of the balance write path. `authenticated` has no UPDATE
 * grant on `dew_wallets` at all — the old rules watched `spent` non-decreasing
 * with a `.validate`, and the equivalent guarantee here is that a client cannot
 * reach the column directly. The function only ever adds a positive amount, only
 * ever to `auth.uid()`'s own row, and does it as one statement, so the
 * read-modify-write race the ETag dance used to paper over no longer exists.
 *
 * SECURITY DEFINER is required for the write to be possible; the argument is
 * clamped so a caller cannot arrive with a negative or absurd charge and have
 * the definer's rights turn it into a refund.
 */
create or replace function public.deduct_dew(p_amount numeric)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  charged numeric := least(round(greatest(coalesce(p_amount, 0), 0), 3), 100000);
  total numeric;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if charged <= 0 then
    select spent into total from public.dew_wallets where owner = auth.uid();
    return coalesce(total, 0);
  end if;

  insert into public.dew_wallets (owner, spent, updated_at)
  values (auth.uid(), charged, now())
  on conflict (owner) do update
    set spent = public.dew_wallets.spent + excluded.spent,
        updated_at = now()
  returning spent into total;

  return total;
end;
$$;

revoke all on function public.deduct_dew(numeric) from public;
grant execute on function public.deduct_dew(numeric) to authenticated;

/**
 * One code, by its exact word, for a signed-in caller.
 *
 * The Realtime Database let any signed-in visitor read `codes/$code` as long as
 * they already knew the word. Row-level security cannot say "only if you already
 * know the key", so the table itself is administrator-only and this function is
 * the door: it answers for an exact, normalised match and nothing else, which
 * keeps the old property that a visitor can check a code they were given without
 * being able to sweep the list.
 */
create or replace function public.lookup_redeem_code(p_code text)
returns table (code text, dew numeric, active boolean, note text, created_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.code, c.dew, c.active, c.note, c.created_at
  from public.redeem_codes c
  where c.code = upper(p_code);
$$;

revoke all on function public.lookup_redeem_code(text) from public;
grant execute on function public.lookup_redeem_code(text) to anon, authenticated;

-- ── Policies ────────────────────────────────────────────────────────────────

alter table public.redeem_codes enable row level security;
alter table public.redeems enable row level security;
alter table public.dew_credits enable row level security;
alter table public.dew_wallets enable row level security;
alter table public.dew_transactions enable row level security;

drop policy if exists redeem_codes_admin on public.redeem_codes;
create policy redeem_codes_admin on public.redeem_codes
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists redeems_owner_read on public.redeems;
create policy redeems_owner_read on public.redeems
  for select to authenticated
  using (owner = auth.uid());

-- Insert-only, never update: a claim whose timestamp could move would restart
-- the window every time it was typed, which is how one word becomes unlimited
-- time. The old `.validate` compared `data` with `newData` for exactly this.
drop policy if exists redeems_owner_claim on public.redeems;
create policy redeems_owner_claim on public.redeems
  for insert to authenticated
  with check (owner = auth.uid() and public.redeem_code_is_live(code));

drop policy if exists redeems_admin on public.redeems;
create policy redeems_admin on public.redeems
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists dew_credits_owner_read on public.dew_credits;
create policy dew_credits_owner_read on public.dew_credits
  for select to authenticated
  using (owner = auth.uid());

drop policy if exists dew_credits_owner_grant on public.dew_credits;
create policy dew_credits_owner_grant on public.dew_credits
  for insert to authenticated
  with check (owner = auth.uid() and public.dew_credit_allowed(code, amount));

drop policy if exists dew_credits_admin on public.dew_credits;
create policy dew_credits_admin on public.dew_credits
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists dew_wallets_owner_read on public.dew_wallets;
create policy dew_wallets_owner_read on public.dew_wallets
  for select to authenticated
  using (owner = auth.uid());

drop policy if exists dew_wallets_admin on public.dew_wallets;
create policy dew_wallets_admin on public.dew_wallets
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists dew_transactions_owner_read on public.dew_transactions;
create policy dew_transactions_owner_read on public.dew_transactions
  for select to authenticated
  using (owner = auth.uid());

drop policy if exists dew_transactions_owner_append on public.dew_transactions;
create policy dew_transactions_owner_append on public.dew_transactions
  for insert to authenticated
  with check (owner = auth.uid() and type = 'usage' and dew > 0);

drop policy if exists dew_transactions_admin on public.dew_transactions;
create policy dew_transactions_admin on public.dew_transactions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.redeem_codes to authenticated;
grant select, insert, update, delete on public.redeems to authenticated;
grant select, insert on public.dew_credits to authenticated;
grant select on public.dew_wallets to authenticated;
grant select, insert on public.dew_transactions to authenticated;
