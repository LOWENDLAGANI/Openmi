-- ── DeepSeek joins the keys an account may bring ────────────────────────────
-- `provider_keys.provider` is a closed list, which is what keeps a typo or a
-- provider the routes do not know about out of the table. DeepSeek V4.1 Flash
-- is now served by its own mode, so the list grows by exactly one value.
--
-- The original constraint was created inline and therefore carries Postgres's
-- generated name; it is dropped by that name and replaced with a named one so
-- the next provider to be added can be a one-line change here.

-- Both names are dropped: the inline constraint's generated name and the
-- named one this file adds. A re-run that only dropped the first would stop at
-- "constraint already exists" and leave every later migration unapplied.
alter table public.provider_keys
  drop constraint if exists provider_keys_provider_check;

alter table public.provider_keys
  drop constraint if exists provider_keys_provider_allowed;

alter table public.provider_keys
  add constraint provider_keys_provider_allowed
  check (provider in ('openrouter', 'gemini', 'groq', 'deepseek'));
