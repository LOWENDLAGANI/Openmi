-- ── The Focus home layout ────────────────────────────────────────────────────
--
-- `classic` is the headline over the composer. `focus` is the mobile design:
-- a "New chat" bar, the mark and its repository chip in the middle, and the
-- composer at the foot. The choice follows the account like every other
-- preference, so a second browser opens on the same home screen.
--
-- The column is added with a default rather than a nullable value: a row that
-- predates this migration has made no choice, and `classic` is what it is
-- already looking at. As with appearance, existing rows are not rewritten.

alter table public.user_preferences
  add column if not exists home_layout text not null default 'classic'
    check (home_layout in ('classic', 'focus'));
