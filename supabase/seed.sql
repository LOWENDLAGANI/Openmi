-- ── Openmi — the rows a fresh project needs ─────────────────────────────────
--
-- Two things, both required for the app to behave the way it did on Firebase:
--
--   1. The administrator's address. This is the row every admin policy compares
--      against, so a project without it has no administrator and the console
--      refuses everybody. It must be the same address as OPENMI_ADMIN_EMAIL in
--      the deployment environment: the environment copy only produces a
--      readable error message, this row is what actually decides.
--
--      CHANGE THIS ADDRESS before you run the file. It is seeded with the one
--      the old `database.rules.json` named so an existing deployment keeps
--      working unchanged.
--
--   2. The single configuration row, at its permissive defaults. A missing row
--      is treated as "no restriction configured" by the app anyway, so this is
--      a convenience: it gives the console something to write to on the very
--      first save.
--
-- Safe to re-run. Both statements are upserts.

insert into public.app_admin (id, email)
values (1, 'myrealmetvreal@gmail.com')
on conflict (id) do update set email = excluded.email;

insert into public.app_config (id)
values (1)
on conflict (id) do nothing;
