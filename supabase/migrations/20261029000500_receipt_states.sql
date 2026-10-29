-- ── A receipt has three states, and the buyer can see which one ─────────────
--
-- `new` and `saved` described the owner's filing, not the payment. A receipt
-- that had been opened, checked and refused was still `new`, so the buyer's list
-- said "pending review" about a payment that had already been answered — and the
-- only way to learn the answer was to ask. The states are now what they claim to
-- be:
--
--   * `pending`  — sent, nobody has decided yet;
--   * `approved` — the money was confirmed;
--   * `rejected` — it was checked and refused (the wrong amount, a screenshot
--                  of somebody else's transfer, a payment that never arrived).
--
-- The decision keeps its timestamp and its author, which the existing columns
-- already recorded for the one answer the table used to have. They are renamed
-- here because only one of them was ever true: a rejection is not a save.
--
-- Nothing about who may write what changes: a buyer still writes their own row
-- as `pending` and cannot decide it, and only the administrator can move it.

alter table public.payment_receipts
  drop constraint if exists payment_receipts_status_check;

update public.payment_receipts set status = 'pending' where status = 'new';
update public.payment_receipts set status = 'approved' where status = 'saved';

alter table public.payment_receipts
  alter column status set default 'pending';

alter table public.payment_receipts
  add constraint payment_receipts_status_check
  check (status in ('pending', 'approved', 'rejected'));

alter table public.payment_receipts rename column saved_at to decided_at;
alter table public.payment_receipts rename column saved_by to decided_by;

-- The sweep reads decided rows by this pair, so it is indexed together. The old
-- name is dropped rather than left to describe a column that no longer exists.
drop index if exists public.payment_receipts_saved_idx;
create index if not exists payment_receipts_decided_idx
  on public.payment_receipts (status, decided_at);

-- A buyer opens a receipt in the one state they are allowed to write. The policy
-- named `saved_at`/`saved_by` before; both the names and the value change.
drop policy if exists payment_receipts_insert_own on public.payment_receipts;
create policy payment_receipts_insert_own on public.payment_receipts
  for insert to authenticated
  with check (
    owner = auth.uid()
    and status = 'pending'
    and decided_at is null
    and decided_by is null
  );

-- ── The ledger learns the rejection ────────────────────────────────────────
-- An approval and a rejection are two different judgements, and a log that calls
-- both "saveReceipt" cannot answer "who refused this payment". The closed list
-- gains the word rather than overloading the old one.

alter table public.admin_audit
  drop constraint if exists admin_audit_action_allowed;
alter table public.admin_audit
  drop constraint if exists admin_audit_action_check;

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
      'rejectReceipt',
      'deleteReceipt'
    )
  );

notify pgrst, 'reload schema';
