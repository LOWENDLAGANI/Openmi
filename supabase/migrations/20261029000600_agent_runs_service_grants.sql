-- ── The service role's privileges on `agent_runs` ───────────────────────────
--
-- `20261029000000_agent_runs.sql` created the table and granted `authenticated`
-- SELECT, then left the writer's privileges to Supabase's default privileges for
-- the `public` schema. That default is a project setting, not a property of this
-- folder: it is absent on a project whose defaults were reset, on a project
-- restored from a dump that did not carry them, and on a table that already
-- existed when the migration ran (`create table if not exists` does not re-grant
-- anything on a table it did not create).
--
-- The symptom is precise and misleading: the table exists, the health audit
-- reports it present, `/api/setup` stays quiet — and every repository turn fails
-- with `42501 permission denied for table agent_runs`, because the tick's
-- service-role client has no INSERT. This file removes that dependency by
-- granting what the tick actually does, explicitly.
--
-- Scope: the two tables `lib/supabaseAdmin.ts` touches, and only to
-- `service_role`. The tick reads a run, claims it, saves progress and closes it,
-- then upserts the `changesets` row that run produced. `authenticated` gains
-- nothing here — the browser still cannot create, rewind or finish a run, which
-- is the property `20261029000000_agent_runs.sql` was written to keep.
--
-- Safe to run more than once: `grant` of a privilege a role already holds is a
-- no-op, and the role is checked first so a Postgres without `service_role`
-- (the migration check's stub) still applies the file.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant select, insert, update, delete on public.agent_runs to service_role';
    execute 'grant select, insert, update, delete on public.changesets to service_role';
  end if;
end
$$;
