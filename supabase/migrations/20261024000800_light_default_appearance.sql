-- ── Openmi opens light ────────────────────────────────────────────────────────
--
-- The appearance column was created with `default 'dark'`, which made night the
-- default for every account that had never opened Settings. The product now
-- opens on paper: light is the default everywhere — the first paint, the local
-- preference and this column.
--
-- Only the default changes. Existing rows are left exactly as they are: a row
-- saying `dark` is either somebody's choice or a default written before this
-- migration, and there is no way to tell the two apart from here. Overwriting
-- them would silently flip the appearance of people who picked night on
-- purpose. The app's own light default covers the read side.

alter table public.user_preferences
  alter column appearance set default 'light';
