# The Supabase project

`database.rules.json` is gone. This directory is what replaced it: the tables
every Realtime Database tree became, and the row-level security policies that
carry the rules it used to hold.

## Layout

| File | What it holds |
| --- | --- |
| `migrations/20261023000000_init.sql` | The administrator address, `is_admin()`, `app_config`, and the realtime publication. |
| `migrations/20261023000100_identity.sql` | `profiles`, `visitor_registry`, `push_subscriptions`, `usage_daily`. |
| `migrations/20261023000200_chats.sql` | `chats`, `chat_messages`, `memories`. |
| `migrations/20261023000300_github_projects.sql` | `github_links`, `github_connections`, `github_default`, `projects`. |
| `migrations/20261023000400_changesets.sql` | `changesets`, `approvals`, `commits`, `admin_audit`. |
| `migrations/20261023000500_dew_redeem.sql` | `redeem_codes`, `redeems`, the Dew ledger, and the functions that keep a claim from naming its own price. |
| `migrations/20261024000000_user_preferences.sql` | `user_preferences`: the account-synced appearance, response length, reasoning effort, search mode, model, tour flag and display name. |
| `migrations/20261024000100_folders_trash.sql` | `folders`, `trash`, and `chats.folder_id`: the sidebar follows the account, and deleted chats stay restorable for thirty days on every device. |
| `migrations/20261024000200_daily_dew.sql` | The daily free Dew bucket on `dew_wallets`, and the rewritten `deduct_dew()` that spends it before paid credit and resets it at midnight in Kuala Lumpur. |
| `migrations/20261024000300_dew_timezone.sql` | `profiles.timezone`, the write-once `set_profile_timezone()` the browser reports through, and the final `deduct_dew()` that resets the bucket at midnight in the account's own zone (Kuala Lumpur when none is stored). |
| `migrations/20261024000400_schema_health.sql` | `openmi_schema_health()`: a public, presence-only audit that names the migration missing when a table, column or function is absent. Read by the About page's setup banner. |
| `migrations/20261024000500_dew_activity.sql` | `free_dew`/`paid_dew` on `dew_transactions`, `deduct_dew_split()` which reports both halves of a charge, and the audit learning about them. |
| `migrations/20261024000600_referrals.sql` | `referral_codes`, `referrals`, the write-once `ensure_referral_code()`, the capped `claim_referral(text)`, and the table-driven `schema_expected` list behind the health audit. |
| `migrations/20261024000700_shares.sql` | `shared_chats` (owner-only, thirty-day expiry, revocable) and the anonymous `shared_public` view, which has no owner column and hides revoked or expired rows. |
| `migrations/20261024000800_light_default_appearance.sql` | Light is the default appearance for a preference row that has not chosen one. Existing rows are left untouched. |
| `migrations/20261026000000_provider_keys.sql` | `provider_keys`: an account's own OpenRouter, Gemini or Groq key, sealed before it is stored and readable only by its owner. Registered in `schema_expected`. |
| `seed.sql` | The administrator's address and the default config row. |

## Apply it

With the Supabase CLI, from the repository root:

```bash
supabase link --project-ref <your-project-ref>
supabase db push          # runs every migration in order
supabase db execute --file supabase/seed.sql   # or paste seed.sql into the SQL editor
```

Or paste the migrations in filename order, then `seed.sql`, into the project's
SQL editor. Nothing in the app can create these tables for you: the app
deliberately holds no service-role key, so a table it has no grant on is a table
it cannot make.

## Enable the sign-in methods

Openmi requires an account and offers four doors. In **Authentication → Sign In /
Providers**:

- **Email** — register and sign in with an address and password. Turn off
  "Confirm email" if you want registration to sign a person in immediately;
  leave it on and the form offers a resend instead of blocking.
- **Google** — create an OAuth client in Google Cloud Console. Its authorized
  redirect URI is `https://<project-ref>.supabase.co/auth/v1/callback`. Paste
  the client id and secret into the provider settings.
- **GitHub** — create an OAuth App at GitHub → Settings → Developer settings →
  OAuth Apps. The authorization callback URL is
  `https://<project-ref>.supabase.co/auth/v1/callback`. Paste the client id and
  secret into the provider settings.
- **Azure** — this is the Microsoft door. Create an app registration in
  Microsoft Entra ID with the same
  `https://<project-ref>.supabase.co/auth/v1/callback` redirect URI, and paste
  the application (client) id and secret into the provider settings.

Then set **Authentication → URL Configuration**: the Site URL is the deployed
origin, and the Redirect URLs list must contain that origin plus
`http://localhost:3000` for local development. Add the recovery path as well —
`https://<your-domain>/auth/reset-password` and
`http://localhost:3000/auth/reset-password` — because the reset mail deliberately
returns to the screen that asks for a new password instead of the product. Every
authentication round trip ends on this origin, where the Supabase client
exchanges the PKCE code for a session.

**Anonymous sign-ins is not used and should stay off.** There is no guest mode:
the sign-in screen is the whole interface until one of the four doors returns a
session.

**Manual linking** (Authentication → Sign In / Providers) must be on for
**Settings → Account → Sign-in methods** to attach a second provider to an
existing account. It is what keeps one person from ending up with two accounts
when they press a different provider than the one they first used; with it off,
linking is refused with `manual_linking_disabled` and the account screen says so.
Unlinking is refused by Supabase when the credential is the account's last way
in, which is why the screen does not offer it there.

## What the policies promise

- Every user-scoped row is owned by `auth.uid()`. A token for one person cannot
  read another person's rows, and there is no policy that would let it.
- The administrator is whoever `app_admin.email` names, compared against the
  verified `email` claim in the JWT. `public.is_admin()` is the only reader of
  that table, so the address is never served to a browser as data.
- No service-role key exists anywhere in this deployment. Every read and write
  the app makes carries the caller's own JWT, so RLS is the only judge — the same
  property `database.rules.json` gave the Firebase build.
- `visitor_registry` is writable by its owner and readable only by the
  administrator. That asymmetry is deliberate and is what the old rules did: a
  visitor may say who they are, not see who else is here.
- `user_preferences` is owner-only like every other user table, so the settings a
  person chose on one browser are readable on another and by nobody else.
- A Dew credit can only be written for the trial amount under `TRIAL`, or for
  exactly the amount a live code carries. `spent` only moves through
  `deduct_dew()`, which `authenticated` can call but not bypass.
- A referral is claimed only through `claim_referral()`, which writes both fixed 25-Dew credits in one transaction. The referred uid is the primary key (one invitation per account), self-referral is refused by a check constraint, and a referrer is capped at ten invitations. The browser can read its own referral rows, never insert one.
- `dew_wallets` also carries the daily free bucket (`daily_day`, `daily_spent`).
  `deduct_dew()` spends that bucket before paid credit and discards what is left
  when the day changes at midnight in the account's own timezone
  (`profiles.timezone`, filled once by `set_profile_timezone()`; Kuala Lumpur
  when none is stored). The bucket only moves forward, so a stored day in the
  future never refills early. The columns are readable so a balance can be
  derived, and writable only through the function.

## Admin sign-in

The console needs a session whose JWT carries the administrator's address. Create
that user once in **Authentication → Users → Add user** with the address from the
seed and a password of your choosing, and confirm it. The console's gate accepts
email and password (and Google, when the provider is configured).
