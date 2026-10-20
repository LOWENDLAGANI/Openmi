-- Daily task quota primitives.
--
-- These are the only place a daily budget is checked. The check-and-increment
-- happens inside a single INSERT ... ON CONFLICT ... WHERE statement, so N
-- concurrent requests for the last remaining slot can only ever succeed once.
-- Execute is revoked from anon/authenticated: only the Worker's service role
-- (and therefore the Workflow) may move counters.

create or replace function public.consume_task_quota(p_user_id uuid, p_limit integer)
returns table (allowed boolean, used integer, "limit" integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_used integer;
begin
  if p_limit is null or p_limit <= 0 then
    raise exception 'p_limit must be a positive integer' using errcode = '22023';
  end if;

  insert into public.usage_daily (user_id, day, tasks_started)
  values (p_user_id, v_day, 1)
  on conflict (user_id, day) do update
    set tasks_started = usage_daily.tasks_started + 1,
        updated_at = now()
    where usage_daily.tasks_started < p_limit
  returning usage_daily.tasks_started into v_used;

  if v_used is null then
    -- Row existed and the WHERE clause blocked the update: budget exhausted.
    select ud.tasks_started into v_used
    from public.usage_daily ud
    where ud.user_id = p_user_id and ud.day = v_day;

    return query select false, coalesce(v_used, p_limit), p_limit;
    return;
  end if;

  return query select true, v_used, p_limit;
end;
$$;

create or replace function public.refund_task_quota(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  update public.usage_daily
  set tasks_started = greatest(tasks_started - 1, 0),
      updated_at = now()
  where user_id = p_user_id and day = v_day;
end;
$$;

create or replace function public.record_ai_call(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
begin
  insert into public.usage_daily (user_id, day, tasks_started, ai_calls)
  values (p_user_id, v_day, 0, 1)
  on conflict (user_id, day) do update
    set ai_calls = usage_daily.ai_calls + 1,
        updated_at = now();
end;
$$;

revoke all on function public.consume_task_quota(uuid, integer) from public;
revoke all on function public.consume_task_quota(uuid, integer) from anon;
revoke all on function public.consume_task_quota(uuid, integer) from authenticated;
grant execute on function public.consume_task_quota(uuid, integer) to service_role;

revoke all on function public.refund_task_quota(uuid) from public;
revoke all on function public.refund_task_quota(uuid) from anon;
revoke all on function public.refund_task_quota(uuid) from authenticated;
grant execute on function public.refund_task_quota(uuid) to service_role;

revoke all on function public.record_ai_call(uuid) from public;
revoke all on function public.record_ai_call(uuid) from anon;
revoke all on function public.record_ai_call(uuid) from authenticated;
grant execute on function public.record_ai_call(uuid) to service_role;
