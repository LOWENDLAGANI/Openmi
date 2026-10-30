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
| `migrations/20261027000000_provider_keys_deepseek.sql` | Adds DeepSeek to the `provider_keys.provider` list, so the DeepSeek V4.1 Flash mode can use a key the account brought. |
| `migrations/20261028000000_pricing_sessions.sql` | `paid_passes` (read-only to its owner, granted only by `admin_grant_plan()`), the 10-free/15-paid daily bucket in `deduct_dew_split()`, and `hour_sessions` with the `start_hour_session()`/`end_hour_session()` pair that charges and enforces one live session per account. |
| `migrations/20261028000200_charge_dew.sql` | The only charge: `start_hour_session()` charges 3 Dew for one hour of usage, with the free daily bucket paying first. Drops `deduct_dew()`, `deduct_dew_split()`, `dew_charge()` and the old per-chat session function, so no per-request charge remains. Recreates `hour_sessions` per account, plus `paid_passes` and `has_paid_pass()`. |
| `migrations/20261028000300_session_scope.sql` | `hour_sessions.model`, `project_id` and `repo_full_name`, and `start_hour_session(p_model text, p_project_id text)`: an hour is bound to the one model and, when started in the repository workspace, the one repository it was bought for. The function validates both against what the account owns and answers a second start with the live binding, so the routes can name the active model or repository and offer ending the hour. |
| `migrations/20261028000400_email_guard.sql` | `blocked_email_domains`, the `email_domain_is_blocked()` check, and the `reject_disposable_signup` trigger on `auth.users`: a disposable address cannot create an account, even from a modified client, while an existing account on one can still sign in. The list mirrors `lib/emailGuard.ts`; both are compared by the tests. |
| `migrations/20261029000000_agent_runs.sql` | `agent_runs`: one row per repository turn. `authenticated` is granted SELECT on its own rows and no write at all — a run is created and advanced through the service key, because it has no caller by design. |
| `migrations/20261029000100_agent_runs_health.sql` | Registers `agent_runs` in `schema_expected`, so a deployment that skipped the migration is named by `/api/setup` instead of failing at the first run. |
| `migrations/20261029000200_receipts_and_deduct.sql` | `payment_receipts`, the private `receipts` bucket behind the top-up page's receipt form, and `admin_deduct_dew()`, the owner-side deduction. Without this file a receipt cannot be sent or listed, and the console cannot take Dew back. |
| `migrations/20261029000300_hour_refunds.sql` | The charge split on `hour_sessions` (`free_charged`, `paid_charged`, `charge_day`), `refund_hour_session()`, `auto_refund_idle_hour()` and `mark_hour_session_activity()`: an hour that produced nothing is given back, once, and only while it was unused. |
| `migrations/20261029000400_deduct_wallet_fix.sql` | Recreates `admin_deduct_dew()` so a deduction works on an account that has credit but no wallet row yet — the state every freshly topped-up buyer is in — and gives the owner a sentence instead of an empty failure. |
| `migrations/20261029000500_receipt_states.sql` | Receipt states become `pending`, `approved` and `rejected` (with existing rows migrated), `saved_at`/`saved_by` become `decided_at`/`decided_by`, and the ledger gains `rejectReceipt` so a refusal is recorded as its own answer. |
| `seed.sql` | The administrator's address and the default config row. |

## Apply it

With the Supabase CLI, from the repository root:

```bash
supabase link --project-ref <your-project-ref>
supabase db push          # runs every migration in order
supabase db execute --file supabase/seed.sql   # or paste seed.sql into the SQL editor
```

Or paste the migrations in filename order, then `seed.sql`, into the project's
SQL editor. Nothing in the app can create these tables for you, and the one
privileged key it holds (`SUPABASE_SERVICE_ROLE_KEY`, read only by
`lib/supabaseAdmin.ts`) is not a schema tool: a table it has no grant on is a
table it cannot make.

### When the folder and the project's history disagree

`supabase db push` compares these files with the project's own
`supabase_migrations.schema_migrations` table. Two different histories produce
two different symptoms, and neither is fixed by deleting rows by hand:

| Symptom | What it means |
| --- | --- |
| `Found local migration files to be inserted before the last migration on remote database` | the project has a version this folder does not, or a file was renamed after it was pushed |
| a route answers `PGRST202` / `relation "…" does not exist` | a migration was never applied, so the build is newer than the schema |
| starting a run answers `503 run-table-missing` | `20261029000000_agent_runs.sql` has not been applied |

Use `supabase migration list` to see both sides, then `supabase migration
repair` to record what is actually true — `applied` only for a version whose
objects are really in the database, `reverted` only for one that never ran — and
push again:

```bash
supabase migration list
supabase migration repair --status applied 20261029000000
supabase db push
```

Every file here is safe to run more than once. Policies are dropped before they
are created, constraints are dropped or guarded by a catalog check, `alter
table` adds use `if not exists`, and the column renames in
`20261029000500_receipt_states.sql` check for the old name first. That makes the
other honest repair — pasting `migrations/*.sql` in filename order, then
`seed.sql`, into the SQL editor — produce the same schema without stopping at
"already exists". `tests/migrations.test.ts` enforces those properties, so a new
migration cannot quietly break the repair path.

After either route, ask the database what is still missing:

```sql
select object_name, migration
from public.openmi_schema_health()
where not present
order by migration;
```

An empty result is the finished state. A row naming `20261029000000_agent_runs`
is exactly the one behind "This run could not be recorded".

## Enable background runs (optional)

A repository turn normally stops when the tab that asked for it closes. With two
extras it outlives the tab.

1. **Apply `20261029000000_agent_runs.sql`.** Without the table, starting a run
   answers 503 with `detail: run-table-missing` and names the migration; the
   in-tab step loop still works.
2. **Set `SUPABASE_SERVICE_ROLE_KEY`** on the deployment. This is what
   `lib/supabaseAdmin.ts` reads, and the run routes are its only importer: a
   tick has no caller, so it cannot borrow a JWT. Unset means background runs
   are off, not that the agent is broken.
3. **Set `AGENT_SWEEP_SECRET`** to any long random string (`openssl rand -hex
   32`) and schedule the watchdog below. Unset means `POST
   /api/agent/runs/sweep` answers 503 `sweep-unconfigured`.

The chain is healthiest when `AGENT_TURN_SECRET` (or `GITHUB_TOKEN_KEY`)
identifies the deployment rather than one process: a tick signed with the
per-process fallback cannot continue a turn that started on another instance.

### The watchdog schedule

A tick is a fire-and-forget request to the next link. A deploy, a cold start or a
process that died between the write and the dispatch leaves a run at `running`
with nothing to advance it. The sweep turns that into a retry; it spends nothing
when there is nothing stale, because the tick it fires still has to win a claim.

Run this once in the SQL editor, with the same secret as `AGENT_SWEEP_SECRET`:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<AGENT_SWEEP_SECRET>', 'openmi_sweep_secret');

select cron.schedule(
  'openmi-agent-run-sweep',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<your-origin>/api/agent/runs/sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-openmi-sweep',
      (select decrypted_secret from vault.decrypted_secrets where name = 'openmi_sweep_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
```

To check it: `select * from cron.job where jobname =
'openmi-agent-run-sweep';` lists the job, and `select status_code from
net._http_response order by id desc limit 5;` shows what the endpoint answered —
200 with `{checked, revived, abandoned}` is a working sweep, 403 is a secret
mismatch, and 503 means the deployment variable is missing.

Without this job nothing creates runs (the table stays empty) and a broken chain
is never recovered — the feature keeps working, in that every run that completes
keeps its answer, but a dropped link becomes a row nobody advances.

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
- Every read and write a browser triggers carries the caller's own JWT, so RLS is
  the judge — the same property `database.rules.json` gave the Firebase build.
  The single exception is the run routes (`lib/supabaseAdmin.ts`), which create
  and advance a run that outlives its tab and so has no caller by design.
  `agent_runs` grants `authenticated` SELECT and no write for exactly that reason.
- `visitor_registry` is writable by its owner and readable only by the
  administrator. That asymmetry is deliberate and is what the old rules did: a
  visitor may say who they are, not see who else is here.
- `user_preferences` is owner-only like every other user table, so the settings a
  person chose on one browser are readable on another and by nobody else.
- A Dew credit can only be written for the trial amount under `TRIAL`, or for
  exactly the amount a live code carries. `spent` only moves through
  `start_hour_session()`, which `authenticated` can call but not bypass.
- A referral is claimed only through `claim_referral()`, which writes both fixed 25-Dew credits in one transaction. The referred uid is the primary key (one invitation per account), self-referral is refused by a check constraint, and a referrer is capped at ten invitations. The browser can read its own referral rows, never insert one.
- `dew_wallets` also carries the daily free bucket (`daily_day`, `daily_spent`).
  `start_hour_session()` spends that bucket before paid credit and discards what is left
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
