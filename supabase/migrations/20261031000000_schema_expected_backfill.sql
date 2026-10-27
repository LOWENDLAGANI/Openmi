-- ── The objects the presence audit never learned about ──────────────────────
--
-- Every migration registers what it adds in `schema_expected` — except these:
-- `usage_daily`, `forget_visitor()`, `github_links`, `github_default`,
-- `admin_audit` and `chat_jobs` were created but never listed, so
-- `openmi_schema_health()` could not see them at all. `chat_jobs` is the sharpest
-- case: its migration (20261029000000_chat_jobs) registered nothing, so a
-- database missing that table answered the audit with a clean bill of health.
--
-- The `migration` column points at this file rather than at the migration that
-- creates each object, because this file is what makes the registration true:
-- until it runs, the application's own copy of the list
-- (EXPECTED_SCHEMA in lib/schemaHealth.ts) reports these names as pending here,
-- and once it runs the catalog answers presence for them itself.

insert into public.schema_expected (object_name, kind, migration) values
  ('usage_daily', 'table', '20261031000000_schema_expected_backfill'),
  ('forget_visitor()', 'function', '20261031000000_schema_expected_backfill'),
  ('github_links', 'table', '20261031000000_schema_expected_backfill'),
  ('github_default', 'table', '20261031000000_schema_expected_backfill'),
  ('admin_audit', 'table', '20261031000000_schema_expected_backfill'),
  ('chat_jobs', 'table', '20261031000000_schema_expected_backfill')
on conflict (object_name) do nothing;
