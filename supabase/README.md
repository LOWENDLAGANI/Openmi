# Supabase setup

## Apply migrations

```bash
# With the Supabase CLI linked to your project
supabase db push

# Or paste each file into the SQL editor, in filename order
```

Order matters: `_init.sql` creates the schema, `_quota.sql` adds the RPCs and grants.

## Auth provider

1. **Authentication → Providers → GitHub**: enable and set the client ID/secret from your GitHub
   OAuth app.
2. Scopes: the app requests `repo read:user`. Without `repo`, `/api/github/link` returns
   `GITHUB_FORBIDDEN`.
3. **Redirect URLs**: add your origins, e.g. `http://localhost:3000/**` and
   `https://your-app.example/**`.

## What lives where

| Object | Purpose |
| --- | --- |
| `profiles` | GitHub login/avatar cache, created on first `/api/me` |
| `github_credentials` | Encrypted OAuth token + granted scopes (no client access via RLS) |
| `projects` | Connected repositories and their commit mode |
| `tasks` | Prompt, pinned base commit, patch set, result, token usage |
| `task_events` | Append-only agent timeline shown in the UI |
| `usage_daily` | Daily budget ledger |
| `github_installations` | GitHub App installations, linked to a user by the signed install state |
| `github_installation_tokens` | Encrypted 1h installation tokens (cache); no client access |
| `consume_task_quota(uuid, int)` | Atomic check-and-increment; `service_role` only |
| `refund_task_quota(uuid)` | Returns a slot when a failure was the system's fault |
| `record_ai_call(uuid)` | Per-day AI call counter for future cost dashboards |

## GitHub App setup

Create a GitHub App with **Contents: read & write**, **Pull requests: read & write**, and **Metadata:
read**, then point its **Setup URL** at `https://<origin>/api/github-app/callback` and its **Webhook
URL** at `https://<origin>/api/webhooks/github`. Subscribe to the `installation` event.

`github_installations.user_id` is nullable on purpose: the webhook can arrive before the browser
callback that carries the signed state, so the row is created first and claimed by the callback.
A partial unique index enforces one linked installation per user.

## RLS model

Clients get `select` only, always scoped to `auth.uid()`. They cannot write: every mutation is
performed by the Worker with the service role after authorization. `github_credentials` is readable
by nobody through the anon key, by design.

## Verifying the quota function

```sql
-- as a superuser/service role
select * from public.consume_task_quota('00000000-0000-4000-8000-000000000000', 2);
-- allowed | used | limit
-- true    | 1    | 2
```

Running it three times in one UTC day must return `allowed = true` twice and `false` once — this is
the property the Worker relies on and the reason the check is a single SQL statement.
