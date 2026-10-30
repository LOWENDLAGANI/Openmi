-- ── The setup audit learns about the run table ──────────────────────────────
--
-- `20261029000000_agent_runs.sql` creates the table a background turn lives in,
-- but the health audit is table-driven: it reports what `schema_expected` names,
-- so a deployment that skipped the migration would look healthy and only fail
-- later, at the first request that tries to start a run (503, with a sentence
-- about the migration nobody reads until then).
--
-- This registers it the way the provider-key and email-guard migrations do, so
-- `/api/setup` and the About page's banner name the migration that is missing.
--
-- The column list is deliberately not audited: `agent_runs` is read and written
-- by two routes, and a missing column is a query error those routes report on
-- their own. A missing table is the failure worth catching before a person has
-- bought an hour.

insert into public.schema_expected (object_name, kind, migration)
values ('agent_runs', 'table', '20261029000000_agent_runs')
on conflict (object_name) do nothing;
