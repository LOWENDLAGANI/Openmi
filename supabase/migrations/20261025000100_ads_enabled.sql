-- ── The ad slot's kill switch ───────────────────────────────────────────────
-- Ads are mandatory for this product, so the console needs a way to stop
-- serving them without a deploy: a policy problem, a broken unit, a review that
-- asked for a pause. The banner additionally requires both public ids, so this
-- flag being true cannot conjure an ad on a deployment that has none.
--
-- Default true keeps the setting the deployment already behaves like; turning
-- it off removes the slot and the height it reserved.
alter table app_config
  add column if not exists ads_enabled boolean not null default true;
