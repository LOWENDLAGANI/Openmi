-- ── The watchdog's schedule, installed with the schema ──────────────────────
--
-- A repository run advances by asking its own origin for the next step. That
-- request is fire-and-forget: a deploy, a cold start, or a process that died
-- between saving progress and handing on leaves the row at `running` with no
-- chain behind it. `app/api/agent/runs/sweep` is the answer to exactly that, and
-- until this file it was an endpoint only a person reading the README would ever
-- schedule.
--
-- So the schedule is part of the schema. One job, every minute, calling the
-- sweep with the shared secret. It costs nothing when nothing is stale: the tick
-- it fires still has to win the claim in `claimRun`, so a sweep that races a live
-- chain does nothing at all.
--
-- Where the secret comes from: **Vault, not this file.** The job reads two
-- secrets by name at run time —
--
--   openmi_sweep_url     this deployment's own sweep URL
--   openmi_sweep_secret  the value the deployment holds in AGENT_SWEEP_SECRET
--
-- which is what keeps a credential out of version control and lets the secrets be
-- created, or rotated, after this migration has already run. Until both exist the
-- job fires and calls nothing (`where … is not null`), so a project that has not
-- finished the setup yet logs no errors and makes no requests.
--
-- Why it is guarded: this folder is applied twice by `bun run check:migrations`
-- to a plain Postgres (PGlite), which has neither `pg_cron`, `pg_net` nor Vault,
-- and a hosted project may have the extensions switched off. The file therefore
-- checks what the database actually offers and schedules nothing when the pieces
-- are absent, instead of failing the batch and skipping every migration after it.
-- Enabling the extensions later needs one re-run of this folder, not an edit.
--
-- Removing the schedule: `select cron.unschedule('openmi-agent-run-sweep');`.
-- Re-running this file recreates it, because `cron.schedule` upserts by job name.

do $$
declare
  has_catalog boolean := to_regclass('pg_catalog.pg_available_extensions') is not null;
  has_cron boolean := false;
  has_net boolean := false;
  installer text;
begin
  if has_catalog then
    has_cron := exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron');
    has_net := exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net');
  end if;

  -- Both extensions are created here rather than assumed: a project restored from
  -- a dump carries the job table's rows, not the extension flags. pg_cron is
  -- tried in its own schema first and in `pg_catalog` second, because Supabase's
  -- own instructions install it the second way; the check after both attempts is
  -- what decides, not the attempt that succeeded.
  if has_cron then
    begin
      execute 'create extension if not exists pg_cron';
    exception
      when others then
        null;
    end;
    if to_regnamespace('cron') is null then
      begin
        execute 'create extension if not exists pg_cron with schema pg_catalog';
      exception
        when others then
          -- Already installed elsewhere, or this role may not add it. The check
          -- below is what decides: the schema has to be there either way.
          null;
      end;
    end if;
    has_cron := to_regnamespace('cron') is not null;
  end if;

  if has_net then
    begin
      execute 'create extension if not exists pg_net';
    exception
      when others then
        null;
    end;
    has_net := to_regnamespace('net') is not null;
  end if;

  if has_cron and has_net and to_regnamespace('vault') is not null then
    installer := $job$
      select cron.schedule(
        'openmi-agent-run-sweep',
        '* * * * *',
        $sweep$
        with config as (
          select
            (select decrypted_secret from vault.decrypted_secrets where name = 'openmi_sweep_url') as url,
            (select decrypted_secret from vault.decrypted_secrets where name = 'openmi_sweep_secret') as secret
        )
        select net.http_post(
          url := config.url,
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-openmi-sweep', config.secret
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 30000
        )
        from config
        where config.url is not null and config.secret is not null;
        $sweep$
      );
    $job$;
    execute installer;
  end if;
end
$$;
