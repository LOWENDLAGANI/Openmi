-- ── Payment receipts, and a deduction the owner can reach ───────────────────
--
-- Two things this file adds, and they belong together because both are about a
-- manual sale the owner settles by hand:
--
--   1. `payment_receipts` carries a proof of transfer a buyer uploads from the
--      top-up page, with the name they want it checked against. The file itself
--      lives in the private `receipts` bucket under the buyer's own folder, so a
--      visitor can only ever see their own upload while the administrator can
--      see every one. A receipt the owner marks saved is wiped — file first,
--      then the row — thirty days later. The wipe runs from the console when the
--      list is read, so no scheduler has to be relied on for the promise.
--
--   2. `admin_deduct_dew()` is the mirror of `admin_grant_dew`-shaped work.
--      `deduct_dew()` only ever touches the caller's own wallet; correcting
--      somebody's balance is an administrator action, so the grant is checked in
--      the database exactly like `admin_grant_plan()` does. A deduction can
--      never push the paid balance below zero, which is what stops a mistyped
--      amount from eating the next top-up.
--
-- Nothing here can be reached by a caller without a verified session, and a
-- modified browser can only call doors that re-check `is_admin()` themselves.

create table if not exists public.payment_receipts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  plan text not null default 'other' check (plan in ('15d', '30d', 'other')),
  plan_label text not null default '' check (length(plan_label) <= 40),
  amount numeric(10, 2) not null default 0 check (amount >= 0 and amount <= 100000),
  reference text not null default '' check (length(reference) <= 120),
  note text not null default '' check (length(note) <= 500),
  storage_path text not null check (length(storage_path) between 1 and 300),
  file_name text not null default '' check (length(file_name) <= 200),
  mime_type text not null default '' check (length(mime_type) <= 100),
  status text not null default 'new' check (status in ('new', 'saved')),
  created_at timestamptz not null default now(),
  saved_at timestamptz,
  saved_by uuid references auth.users (id) on delete set null
);

create index if not exists payment_receipts_created_idx
  on public.payment_receipts (created_at desc);

-- The retention sweep reads saved rows by this pair, so it is indexed together.
create index if not exists payment_receipts_saved_idx
  on public.payment_receipts (status, saved_at);

alter table public.payment_receipts enable row level security;

-- A buyer writes their own receipt, as a new one, and cannot mark it saved:
-- the status and the saving timestamp are the owner's judgement, not theirs.
drop policy if exists payment_receipts_insert_own on public.payment_receipts;
create policy payment_receipts_insert_own on public.payment_receipts
  for insert to authenticated
  with check (
    owner = auth.uid()
    and status = 'new'
    and saved_at is null
    and saved_by is null
  );

drop policy if exists payment_receipts_select_own_or_admin on public.payment_receipts;
create policy payment_receipts_select_own_or_admin on public.payment_receipts
  for select to authenticated
  using (owner = auth.uid() or public.is_admin());

drop policy if exists payment_receipts_update_admin on public.payment_receipts;
create policy payment_receipts_update_admin on public.payment_receipts
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists payment_receipts_delete_admin on public.payment_receipts;
create policy payment_receipts_delete_admin on public.payment_receipts
  for delete to authenticated
  using (public.is_admin());

grant select, insert, update, delete on public.payment_receipts to authenticated;

-- ── The private bucket the proof lives in ───────────────────────────────────
-- Private: a receipt shows somebody's bank transfer, so it is never a public
-- URL. The console reads it through a short-lived signed URL instead. The
-- folder name is the buyer's own uid, which is what the insert policy checks, so
-- one visitor cannot write into another's folder or overwrite an existing file.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

drop policy if exists receipts_upload_own on storage.objects;
create policy receipts_upload_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists receipts_read_own_or_admin on storage.objects;
create policy receipts_read_own_or_admin on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

drop policy if exists receipts_delete_admin on storage.objects;
create policy receipts_delete_admin on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and public.is_admin());

-- ── The owner takes Dew back ────────────────────────────────────────────────
-- The console could only add credit, which meant a refund or a typo could not be
-- corrected from the same screen it was made on. This is the subtraction, held
-- to the same rules as a grant: the admin grant is checked here, the amount is
-- clamped, and only paid Dew is reachable — today's free bucket is not a wallet
-- balance and is not the owner's to take back. The deduction is clamped again to
-- what is actually left, so `spent` can never overtake the credits and quietly
-- tax a later top-up.

create or replace function public.admin_deduct_dew(p_uid uuid, p_dew numeric)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested numeric := least(round(greatest(coalesce(p_dew, 0), 0), 3), 100000);
  credited numeric;
  charged numeric;
  removed numeric;
begin
  if not public.is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if p_uid is null then
    raise exception 'No such account.' using errcode = '22023';
  end if;

  if requested <= 0 then
    raise exception 'A deduction needs a positive amount.' using errcode = '22023';
  end if;

  select coalesce(sum(amount), 0) into credited
    from public.dew_credits
   where owner = p_uid;

  select coalesce(spent, 0) into charged
    from public.dew_wallets
   where owner = p_uid;

  removed := least(requested, greatest(credited - charged, 0));

  if removed <= 0 then
    raise exception 'There is no paid Dew to deduct.' using errcode = '22023';
  end if;

  insert into public.dew_wallets (owner, spent, updated_at)
  values (p_uid, removed, now())
  on conflict (owner) do update
    set spent = public.dew_wallets.spent + excluded.spent,
        updated_at = now();

  return (
    select coalesce(sum(amount), 0) from public.dew_credits where owner = p_uid
  ) - (
    select spent from public.dew_wallets where owner = p_uid
  );
end;
$$;

revoke all on function public.admin_deduct_dew(uuid, numeric) from public;
grant execute on function public.admin_deduct_dew(uuid, numeric) to authenticated;

-- ── The ledger learns the new actions ──────────────────────────────────────
-- The audit was a closed list of five words. A deduction and the two receipt
-- decisions are three more, and an unnamed check left by an older file is
-- dropped by both names it may have had.

alter table public.admin_audit
  drop constraint if exists admin_audit_action_check;

alter table public.admin_audit
  drop constraint if exists admin_audit_action_allowed;

alter table public.admin_audit
  add constraint admin_audit_action_allowed
  check (
    action in (
      'createCode',
      'deleteCode',
      'toggleCode',
      'grantDew',
      'grantPlan',
      'deductDew',
      'saveReceipt',
      'deleteReceipt'
    )
  );

-- ── The health check can name what is missing ──────────────────────────────
-- The setup banner groups missing objects by the migration that adds them, so a
-- deployment that skipped this file says so instead of failing a sale later.

insert into public.schema_expected (object_name, kind, migration)
values
  ('payment_receipts', 'table', '20261029000200_receipts_and_deduct'),
  ('admin_deduct_dew(uuid,numeric)', 'function', '20261029000200_receipts_and_deduct')
on conflict (object_name) do nothing;
