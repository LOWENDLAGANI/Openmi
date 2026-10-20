# OpenMi

Mobile-first cloud vibe-coding. You type a prompt on your phone; a durable background agent edits
your GitHub repository and commits it — even after you close the tab.

**Status:** Phase 0 (walking skeleton), Phase 1 (auth, database, quota, durable agent, atomic
GitHub commits) and Phase 2 (GitHub App installation tokens, webhooks, token caching) are
implemented. See [Roadmap](#roadmap) for what is deliberately deferred.

---

## How it works

```
phone browser
    │  Supabase session (GitHub OAuth)
    ▼
Next-free SPA  ──/api/*──►  Cloudflare Worker (Hono)
                              │  verify Supabase JWT (JWKS, local)
                              │  reserve daily quota (atomic SQL)
                              ▼
                        Cloudflare Workflow  ── durable steps, survives tab close
                              │
                ┌─────────────┼──────────────┬─────────────┐
                ▼             ▼              ▼             ▼
          Supabase PG    GitHub tree     OpenRouter      GitHub
          (task state)   + blobs         / Groq         atomic commit
```

Every unit of work is a Workflow step, so a lost connection, a locked screen, or a closed browser
does not interrupt generation. Task state lives in Postgres, not in the client.

Full design and trade-offs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Cloudflare Workers (`workerd`) |
| Orchestration | Cloudflare Workflows (`WorkflowEntrypoint`, durable steps) |
| API | Hono + TypeScript |
| Frontend | Vite + React 19 + Tailwind CSS v4 (mobile-first SPA) |
| Database / Auth | Supabase Postgres + GitHub OAuth provider + RLS |
| Models | OpenRouter (`qwen/qwen3-coder` default), optional Groq fallback |
| GitHub | `@octokit/rest` — Git Data API, `base_tree` commits, `force: false` ref updates |
| GitHub auth | GitHub App installation tokens (per-repo, revocable) with OAuth fallback |

## Quickstart

### 1. Install

```bash
npm install
```

### 2. Create the database

In a new Supabase project, run the migrations in order (SQL editor, or `supabase db push`):

```
supabase/migrations/20261020000100_init.sql
supabase/migrations/20261020000200_quota.sql
```

Then enable **Authentication → Providers → GitHub** and add `repo read:user` to the scopes.
Set the redirect URL to your app origin (`http://localhost:3000` for local dev).

### 3. Configure the Worker

Public config lives in `wrangler.jsonc` `vars`. Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

Secrets never go in the repo:

```bash
cp .dev.vars.example .dev.vars      # local development
# then, for the deployed Worker:
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put GITHUB_TOKEN_ENC_KEY   # base64 of 32 random bytes
npx wrangler secret put OPENROUTER_API_KEY
```

Generate the token-encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3b. GitHub App (recommended)

Create a GitHub App (Settings → Developer settings → GitHub Apps):

| Setting | Value |
| --- | --- |
| Repository permissions | Contents: **read & write**, Pull requests: **read & write**, Metadata: read |
| Setup URL | `https://<your-origin>/api/github-app/callback` |
| Webhook URL | `https://<your-origin>/api/webhooks/github` |
| Webhook secret | any strong random string |

Put the public ids in `wrangler.jsonc` (`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`)
and the secrets on the Worker:

```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded-app.pem -out app-pkcs8.pem
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem
npx wrangler secret put GITHUB_APP_WEBHOOK_SECRET
```

With the App configured, repo writes use short-lived installation tokens scoped to the
repositories the user installed the App on — no OAuth token needed. The OAuth path remains as a
fallback and is what `/api/github/link` stores.

### 4. Run locally

Two processes, exactly like production topology (the SPA never talks to Supabase from the server):

```bash
npm run dev:api   # wrangler dev + Workflows emulation on :8787
npm run dev       # Vite on :3000, proxies /api -> :8787
```

Open `http://localhost:3000`.

### 5. Deploy

```bash
npm run build          # SPA -> dist/
npx wrangler deploy    # Worker + Workflows + static assets
```

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | var | Project URL; also used as the JWT issuer base |
| `SUPABASE_ANON_KEY` | var | Public key handed to the browser via `/api/config` |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Server-side DB access; bypasses RLS |
| `SUPABASE_JWT_SECRET` | secret (dev only) | Legacy HS256 fallback for local integration tests |
| `GITHUB_TOKEN_ENC_KEY` | secret | AES-256-GCM key for stored GitHub tokens |
| `OPENROUTER_API_KEY` | secret | Primary model provider |
| `GROQ_API_KEY` | secret (optional) | Fallback provider |
| `OPENMI_MODEL` | var | Model slug, default `qwen/qwen3-coder` |
| `DAILY_TASK_LIMIT` | var | Free-tier tasks per user per UTC day (default 5) |
| `MAX_CONCURRENT_TASKS` | var | In-flight tasks per user (default 2) |
| `DEFAULT_COMMIT_MODE` | var | `direct` or `pull_request` fallback for new projects |
| `GITHUB_APP_ID` | var | GitHub App id (enables installation auth when set) |
| `GITHUB_APP_CLIENT_ID` | var | Preferred JWT issuer for App requests; falls back to the app id |
| `GITHUB_APP_SLUG` | var | App slug used to build the install URL |
| `GITHUB_APP_PRIVATE_KEY` | secret | PKCS#8 PEM; signs the App JWT |
| `GITHUB_APP_WEBHOOK_SECRET` | secret | Verifies `X-Hub-Signature-256` |
| `GITHUB_APP_STATE_SECRET` | secret (optional) | HMAC key for install state; defaults to the webhook secret |

## API

All routes are under `/api`. Everything except `/api/health` and `/api/config` requires
`Authorization: Bearer <supabase access token>`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness + which config keys are missing (never values) |
| `GET` | `/api/config` | Public runtime config for the SPA |
| `GET` | `/api/me` | Profile, GitHub link state, remaining daily quota |
| `POST` | `/api/github/link` | Store the OAuth token (encrypted) from sign-in |
| `POST` | `/api/github/app/install` | Mint a signed GitHub App install URL |
| `GET` | `/api/github-app/callback` | Public App setup redirect (signed state) |
| `POST` | `/api/webhooks/github` | Public webhook (HMAC verified) for install lifecycle |
| `GET` | `/api/github/repos` | Repositories the agent can write to (installation or OAuth) |
| `GET` | `/api/projects` | Connected projects |
| `POST` | `/api/projects` | Connect a repo (`repoFullName`, optional `commitMode`) |
| `GET` | `/api/projects/:id/tasks` | Recent tasks for a project |
| `POST` | `/api/tasks` | Accept a prompt (202) → quota reserved → workflow started |
| `GET` | `/api/tasks/:id` | Task detail + agent timeline |

## Safety model

Four independent layers keep a prompt from damaging a repository:

1. **No deletions are representable.** The patch schema only allows `create` and `update`.
   Model-proposed paths are validated against a strict policy: no traversal, no absolute paths,
   no `.github/**` (CI injection), no `.env*`/keys, no binaries, ≤12 files, ≤256 KB each.
2. **`base_tree` commits.** New blobs are attached to the *existing* tree, so untouched files are
   retained by GitHub itself. No local checkout is ever mutated.
3. **Pre-commit invariant.** The resulting tree is fetched and checked to be a superset of the base
   tree *before* a commit object exists. Any missing path aborts the task.
4. **Fast-forward-only refs.** `PATCH /git/refs` is always called with `force: false`. If the branch
   moved, GitHub rejects the update; if a file the agent touched changed meanwhile, the task aborts
   with `GITHUB_CONFLICT` instead of clobbering the human edit.

Cost guardrails: an atomic `consume_task_quota` RPC (`INSERT … ON CONFLICT … WHERE tasks_started <
limit`) makes the daily budget race-free, concurrent-task limits stop workflow stampedes, and
failures caused by the system (provider/config/internal) refund the reserved slot.

## GitHub App access (Phase 2)

`resolveGithubAuth()` is the single seam that decides how the agent may act on GitHub:

1. **App installation** — short-lived (1 h) installation tokens, scoped to the repositories the
   user installed the App on, revocable at any time. Tokens are cached in Postgres (encrypted) and
   in-isolate, refreshed 5 minutes before expiry, and re-minted exactly once on a dead token.
2. **OAuth fallback** — the Phase 1 token, for deployments without an App and for users who have
   not installed it yet.

Install attribution never trusts the `installation_id` query parameter: GitHub's redirect carries a
signed, 15-minute `state` issued only to an authenticated session, and the App then re-reads the
installation from the API to confirm it belongs to this App. Webhooks are verified over the raw
body with `X-Hub-Signature-256` and keep the installation table in sync (`created`, `deleted`,
`suspend`, `unsuspend`).

## Verification

```bash
npm run typecheck    # worker, SPA, and build-tool configs
npm test             # unit, workflow, and API tests
npm run build        # SPA bundle
npm run check:bundle # wrangler dry-run: Worker + Workflows + assets
npm run verify       # all of the above
```

Tests cover the patch policy, the no-deletion invariant, stale-base detection, context budgeting,
token envelope encryption, model-output parsing, quota windows, API routing/auth gates, the
workflow pipeline (step order, replay safety, refund-on-our-failure, no-refund-on-conflict), App
JWT claims, install-state signing, webhook HMAC verification, installation-token caching, and the
App-vs-OAuth resolution order.

Local end-to-end checks against `wrangler dev` (real `workerd`): `/api/health`, `/api/config`,
401s for missing/bad-signature/wrong-issuer JWTs, `/api/*` 404 JSON, SPA deep-link fallback, and
static asset serving.

Not covered without live credentials: real Supabase reads/writes, a full GitHub OAuth round trip,
and an actual commit. Those are the first things to exercise once secrets are configured.

## Roadmap

- **Phase 2 (done)** — GitHub App installation tokens, webhook lifecycle sync, encrypted token
  cache, install flow with signed state.
- **Phase 3** — repository file browser; re-run failed tasks; streaming agent progress
  (Workflows + SSE); multi-file preview builds; PR review comments; per-user token budget.
- **Phase 4** — team workspaces, billing via Stripe, usage analytics.

## Repo layout

```
worker/            Worker: routes, auth, db, agent, github, workflows
src/               SPA: pages, components, lib
shared/            Wire types shared by both runtimes
supabase/          SQL migrations (schema + quota RPCs)
tests/             Vitest suites
docs/              Architecture notes
```
