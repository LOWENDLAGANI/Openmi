-- ── A deduction works on an account that has never spent ────────────────────
--
-- `admin_deduct_dew()` read the spend with
--
--     select coalesce(spent, 0) into charged from public.dew_wallets
--      where owner = p_uid;
--
-- and that `coalesce` only covers a NULL column, never a missing row. When the
-- visitor has credit but no wallet row — which is every account that was topped
-- up and has not bought an hour yet — the SELECT matches nothing, leaves
-- `charged` NULL, and `greatest(credited - charged, 0)` collapses to 0. `removed`
-- then becomes 0 and the function raises "There is no paid Dew to deduct."
--
-- That is the one case the owner most wants to correct: a top-up typed too large
-- on an account that has not spent any of it yet. The deduction refused exactly
-- the Dew that was easiest to take back.
--
-- The wallet row is now created before it is read, so the arithmetic sees a real
-- zero instead of a missing value, and the returned balance is read back from
-- the row that was actually written.

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

  -- Nothing credited is nothing to take back. Checked before the wallet row is
  -- made, so a deduction against an empty account writes nothing at all.
  if credited <= 0 then
    raise exception 'This account has no paid Dew to deduct.' using errcode = '22023';
  end if;

  -- A wallet that does not exist yet is a wallet that has spent nothing. This is
  -- the row the deduction is written into, and creating it first is what keeps
  -- the clamp below from being NULL.
  insert into public.dew_wallets (owner, spent, updated_at)
  values (p_uid, 0, now())
  on conflict (owner) do nothing;

  select spent into charged
    from public.dew_wallets
   where owner = p_uid;

  if charged is null then
    charged := 0;
  end if;

  if credited - charged <= 0 then
    raise exception 'This account has no paid Dew left to deduct.' using errcode = '22023';
  end if;

  removed := least(requested, greatest(credited - charged, 0));

  update public.dew_wallets
     set spent = spent + removed,
         updated_at = now()
   where owner = p_uid;

  return credited - (
    select spent from public.dew_wallets where owner = p_uid
  );
end;
$$;

revoke all on function public.admin_deduct_dew(uuid, numeric) from public;
grant execute on function public.admin_deduct_dew(uuid, numeric) to authenticated;

insert into public.schema_expected (object_name, kind, migration)
values ('admin_deduct_dew(uuid,numeric)', 'function', '20261029000400_deduct_wallet_fix')
on conflict (object_name) do update
  set kind = excluded.kind,
      migration = excluded.migration;

notify pgrst, 'reload schema';
