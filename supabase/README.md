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

In **Authentication → Sign In / Providers**:

- **Email** — the sign-in the app already offers. Turn off "Confirm email" if you
  want registration to sign a person in immediately; leave it on and the app
  offers a resend instead of blocking.
- **Anonymous sign-ins** — **required**. This build is guest-first, exactly as
  the Firebase one was: a first-time visitor is signed in anonymously so they
  can write a chat before they have an account, and registering upgrades that
  same user in place. Without this toggle nobody can use the app.
- **Google** — optional. The account screen and the admin gate both offer it; it
  does nothing until a Google OAuth client id and secret are pasted into the
  provider settings and the project's callback URL is registered with Google.

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
- A Dew credit can only be written for the trial amount under `TRIAL`, or for
  exactly the amount a live code carries. `spent` only moves through
  `deduct_dew()`, which `authenticated` can call but not bypass.

## Admin sign-in

The console needs a session whose JWT carries the administrator's address. Create
that user once in **Authentication → Users → Add user** with the address from the
seed and a password of your choosing, and confirm it. The console's gate accepts
email and password (and Google, when the provider is configured).
