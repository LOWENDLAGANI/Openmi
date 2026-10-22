# OpenMi

Mobile-first cloud vibe-coding. You type a prompt on your phone; a durable background agent edits
your GitHub repository and commits it — even after you close the tab.

**Status:** Phase 0 (walking skeleton), Phase 1 (auth, database, quota, durable agent, atomic
GitHub commits), Phase 2 (GitHub App installation tokens, webhooks, token caching) and Phase 2.5
(Vercel runtime: serverless runner, leases, cron recovery) are implemented and tested. This is a
clean rebuild on Firebase + Vercel (no Supabase, no Cloudflare). See [Roadmap](#roadmap) for what
is deliberately deferred.

---

## How it works

```
phone browser
    │  Firebase session (Google sign-in, GitHub linked later)
    ▼
Vite SPA  ──/api/*──►  Vercel Function (Hono, Node 22)
                          │  verify Firebase ID token (firebase-admin)
                          │  reserve daily quota (Firestore transaction)
                          │  POST /api/internal/run-task  (self-dispatch, 202)
                          ▼
                    runner invocation ── steps, lease, re-dispatch on timeout
                          │
            ┌─────────────┼──────────────┬─────────────┐
            ▼             ▼              ▼             ▼
        Firestore     GitHub tree     OpenRouter      GitHub
      (task state)   + blobs         / Groq         atomic commit
```

Every stage is a step with an idempotency guard, so a lost connection, a locked screen, a closed
browser or a timed-out function does not lose work: the task is re-dispatched and resumes from
persisted state. Task state lives in Firestore, not in the client.

> **Runtime note:** `firebase-admin` requires a Node runtime, so Vercel Functions (Node 22) is the
> sole runtime. There is no edge/Cloudflare deployment path. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Vercel Functions (Node.js 22) |
| Orchestration | Step pipeline with Firestore transaction leases + self re-dispatch |
| API | Hono + TypeScript |
| Frontend | Vite + React 19 + Tailwind CSS v4 (mobile-first SPA) |
| Database / Auth | Firebase Auth (Google sign-in; GitHub linked to the account afterwards) + Firestore (admin SDK; rules deny client access) |
| Models | OpenRouter (`qwen/qwen3-coder-next` default + fallback chain), optional Groq fallback |
| GitHub | `@octokit/rest` — Git Data API, `base_tree` commits, `force: false` ref updates |
| GitHub auth | GitHub App installation tokens (per-repo, revocable) with OAuth fallback |

## Quickstart

### 1. Install

```bash
git clone https://github.com/LOWENDLAGANI/Openmi.git
cd Openmi
npm install
```

### 2. Create the Firebase project

Create a Firebase project, enable **Authentication → Sign-in method → Google** (the way users
sign in) and **Authentication → Sign-in method → GitHub** (linked after sign-in so the agent can
push; request `repo read:user` scopes) and **Cloud Firestore**, then deploy the rules and
composite indexes:

```bash
cd firebase
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

Generate a service account key (Project settings → Service accounts) and register a web app to get
the public web config. Full walkthrough: [firebase/README.md](firebase/README.md).

### 3. Configure the environment

Copy [.env.example](.env.example) to `.env.local` (used by both `vercel dev` and the local Node API
server), then fill in:

- `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (service account)
- `GITHUB_TOKEN_ENC_KEY` — `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- `OPENROUTER_API_KEY`
- `INTERNAL_TASK_TOKEN` — any random string ≥ 32 chars (`openssl rand -hex 32`)
- `CRON_SECRET` — any random string
- `APP_ORIGIN` — `http://localhost:8787` locally

### 4. GitHub App (recommended)

Create a GitHub App (Settings → Developer settings → GitHub Apps):

| Setting | Value |
| --- | --- |
| Repository permissions | Contents: **read & write**, Pull requests: **read & write**, Metadata: read |
| Setup URL | `https://<your-domain>/api/github-app/callback` |
| Webhook URL | `https://<your-domain>/api/webhooks/github` |
| Webhook secret | the value of `GITHUB_APP_WEBHOOK_SECRET` |

Add `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`
(PKCS#8 PEM: `openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem`) and
`GITHUB_APP_WEBHOOK_SECRET` to the same environment as step 3.

With the App configured, repo writes use short-lived installation tokens scoped to the repositories
the user installed the App on — no OAuth token needed. The OAuth path remains as a fallback.

### 5. Run locally

```bash
npm run dev:api   # Node API server on :8787 (same handler Vercel runs)
npm run dev       # Vite on :3000, proxies /api -> :8787
```

Open `http://localhost:3000`.

### 6. Deploy to Vercel

```bash
npm i -g vercel        # once
vercel link            # create/link the project
```

Add the environment variables from step 3 to **Production** and **Preview**
(Vercel → Project → Settings → Environment Variables, or `vercel env add <NAME>`; put
`GITHUB_APP_PRIVATE_KEY` in as a single line with `\n` escapes). Then:

```bash
vercel --prod
```

After the first deploy, set:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | `https://<your-production-domain>` (inferred from `VERCEL_PROJECT_PRODUCTION_URL` when omitted) |
| `INTERNAL_TASK_TOKEN` | same random value as local |
| `CRON_SECRET` | same random value as local |
| `RUN_BUDGET_SECONDS` | optional, default `50` (clamped to `MAX_FUNCTION_DURATION - 10` so a run never outlives `maxDuration`) |

Then redeploy so the values take effect, and point the GitHub App's Setup/Webhook URLs and the
Firebase authorized domains at the Vercel domain.

**Deployment Protection:** internal dispatch posts to your own deployment. If Vercel Authentication
protects preview deployments, set `INTERNAL_DISPATCH_URL` to an unprotected alias or test on
Production. Cron jobs are exempt from protection.

**Local Vercel emulation:** `vercel dev` works too; it serves the SPA and `/api/*` from
`.env.local`. Do not run it on port 8787 at the same time as `npm run dev:api`.

## Setup checklist

The SPA asks the API which environment variables are set and renders a checklist when a required
one is missing: every variable with its purpose, where to get it, how to set it, and an example
value. The catalogue lives on the server (`server/config-catalogue.ts`) and is served by
`GET /api/health` as `checks` — names, purposes and presence only, never values. The same
catalogue drives `missingConfig`, so the list and the checklist can never drift apart.

The checklist is grouped into **Required** (the app cannot start without them), **Recommended**
(a model provider and GitHub App access) and **Optional** (tuning knobs that all have a working
default). Each row expands to show the exact instructions; "Re-check" re-reads `/api/health", and
"Continue to the app" lets the user through anyway. The startup banner links to the same screen.

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` | var | Firebase project id; also exposed to the browser |
| `FIREBASE_API_KEY` | var | Public web API key handed to the browser via `/api/config` |
| `FIREBASE_AUTH_DOMAIN` | var (optional) | Defaults to `<project-id>.firebaseapp.com` |
| `FIREBASE_APP_ID` | var (optional) | Web app id from the Firebase console |
| `FIREBASE_CLIENT_EMAIL` | secret | Service account client email (server-only) |
| `FIREBASE_PRIVATE_KEY` | secret | Service account PKCS#8 PEM (server-only) |
| `GITHUB_TOKEN_ENC_KEY` | secret | AES-256-GCM key for stored GitHub tokens |
| `OPENROUTER_API_KEY` | secret | Primary model provider |
| `GROQ_API_KEY` | secret (optional) | Fallback provider |
| `OPENMI_MODEL` | var | Primary model slug, default `qwen/qwen3-coder-next` |
| `OPENMI_MODEL_FALLBACKS` | var (optional) | Comma-separated slugs tried in order, default `qwen/qwen3-coder,qwen/qwen3-coder-flash` |
| `GROQ_MODEL` | var (optional) | Groq model slug, default `openai/gpt-oss-120b` |
| `DAILY_TASK_LIMIT` | var | Free-tier tasks per user per UTC day (default 5) |
| `MAX_CONCURRENT_TASKS` | var | In-flight tasks per user (default 2) |
| `DEFAULT_COMMIT_MODE` | var | `direct` or `pull_request` fallback for new projects |
| `APP_ORIGIN` | var (Vercel) | Base URL the runner is dispatched to; inferred on Vercel |
| `INTERNAL_TASK_TOKEN` | secret (Vercel) | Authenticates `POST /api/internal/run-task` |
| `INTERNAL_DISPATCH_URL` | var (optional) | Dispatch to a specific deployment instead of `APP_ORIGIN` |
| `CRON_SECRET` | secret (Vercel) | Vercel sends `Authorization: Bearer $CRON_SECRET` to cron |
| `RUN_BUDGET_SECONDS` | var (optional) | Wall-clock budget per runner invocation (default 50, clamped to `MAX_FUNCTION_DURATION - 10`) |
| `MAX_FUNCTION_DURATION` | var (optional) | Hard ceiling of the function in seconds (default 60; must match `maxDuration` in `api/[[...route]].ts`) |
| `GITHUB_APP_ID` | var | GitHub App id (enables installation auth when set) |
| `GITHUB_APP_CLIENT_ID` | var | Preferred JWT issuer for App requests; falls back to the app id |
| `GITHUB_APP_SLUG` | var | App slug used to build the install URL |
| `GITHUB_APP_PRIVATE_KEY` | secret | PKCS#8 PEM; signs the App JWT |
| `GITHUB_APP_WEBHOOK_SECRET` | secret | Verifies `X-Hub-Signature-256` |
| `GITHUB_APP_STATE_SECRET` | secret (optional) | HMAC key for install state; defaults to the webhook secret |

## API

All routes are under `/api`. Everything except `/api/health`, `/api/config`, the GitHub App
callback/webhook and the runner/cron endpoints requires `Authorization: Bearer <Firebase ID
token>`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness + which config keys are missing (never values) |
| `GET` | `/api/config` | Public runtime config for the SPA |
| `GET` | `/api/me` | Profile, GitHub link state, remaining daily quota |
| `POST` | `/api/github/link` | Store the OAuth token (encrypted) from the GitHub link step |
| `POST` | `/api/github/app/install` | Mint a signed GitHub App install URL |
| `GET` | `/api/github-app/callback` | Public App setup redirect (signed state) |
| `POST` | `/api/webhooks/github` | Public webhook (HMAC verified) for install lifecycle |
| `GET` | `/api/github/repos` | Repositories the agent can write to (installation or OAuth) |
| `GET` | `/api/projects` | Connected projects |
| `POST` | `/api/projects` | Connect a repo (`repoFullName`, optional `commitMode`) |
| `GET` | `/api/projects/:id/tasks` | Recent tasks for a project |
| `POST` | `/api/tasks` | Accept a prompt (202) → quota reserved → runner dispatched |
| `GET` | `/api/tasks/:id` | Task detail + agent timeline |
| `POST` | `/api/internal/run-task` | **Internal.** Runs one task invocation (`x-openmi-internal`) |
| `GET` | `/api/cron/recover` | **Internal.** Re-dispatches stale tasks (`Bearer $CRON_SECRET`) |

### Error shape

Every error answers with the same envelope, and with **every** problem that was found, not just
the first one:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "2 problems: projectId is required; prompt is required",
    "issues": [
      { "code": "MISSING_PROJECT_ID", "message": "projectId is required", "field": "projectId" },
      { "code": "MISSING_PROMPT", "message": "prompt is required", "field": "prompt" }
    ]
  }
}
```

An `Issue` is `{ code, message }` plus whichever of `path` (file path), `field` (request field),
`source` (provider/model) and `status` (HTTP status) applies. `message` is a one-line summary of
all issues, so clients that only show a string still see the whole picture.

The same list is used everywhere problems are detected: request validation (`POST /api/tasks`,
`POST /api/projects`), patch policy (unsafe paths, illegal ops, duplicates, size caps), conflict
detection, model-provider failures (one issue per attempt, so a retired model slug is visible
alongside the fallback that worked) and configuration errors (every missing key at once).

Failed tasks persist the list on the task document (`errorIssues`) and on the timeline, and the SPA
renders it as a list rather than a single string.

## Model providers

The agent talks to OpenRouter first and falls back to Groq. Both providers are called through one
OpenAI-compatible chat-completions request with `response_format: { type: "json_object" }`, and
the model is asked for a JSON patch object only.

The provider chain is built per call: the configured `OPENMI_MODEL`, then every slug in
`OPENMI_MODEL_FALLBACKS`, then `GROQ_MODEL` when a Groq key is present. Every attempt is recorded
(`provider`, `model`, HTTP status, reason) and surfaced on the task timeline, so a task that
succeeded on the third model says so.

Failures are classified before the next attempt is made:

| Status | Treated as | Next step |
| --- | --- | --- |
| 404 | `model_not_found` — the slug was retired or renamed | try the next model, and report the dead slug |
| 401 / 403 | `auth` — the API key is wrong | stop immediately; another model will not help |
| 429 | `rate_limited` | try the next model |
| 5xx / 408 / 409 | `transient` | try the next model |
| other 4xx | `invalid_request` | try the next model |

The defaults track the current model catalogue, not a pinned 2025 slug: `qwen/qwen3-coder-next` is
the primary OpenRouter model with `qwen/qwen3-coder` and `qwen/qwen3-coder-flash` behind it, and
Groq's default is `openai/gpt-oss-120b` (`llama-3.3-70b-versatile` was retired from the free and
Developer tiers in August 2026). Because providers retire slugs without notice, a retired model is
a *recoverable* event: the task falls through to the next model instead of failing outright.

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

Cost guardrails: an atomic `consumeTaskQuota` Firestore transaction (check-and-increment inside a
single transaction) makes the daily budget race-free, concurrent-task limits stop dispatch stampedes, and
failures caused by the system (provider/config/internal) refund the reserved slot.

## Durable execution on serverless

Vercel has no workflow engine, so durability is a property of the data rather than the runtime. The
pipeline runs through an inline `StepRunner` with bounded retries, exponential backoff, and a
wall-clock deadline. Three properties make it durable:

- **Leases.** `tasks.lease_expires_at` decides which invocation owns a task; a crashed invocation's
  lease expires instead of blocking recovery forever.
- **Idempotent stages.** Every stage re-reads the row and skips work already persisted (pinned base,
  stored patch, recorded commit), so replay never commits twice.
- **Re-dispatch.** On deadline the runner releases the lease and posts a fresh invocation, which
  continues from the last completed stage. A daily cron sweep (`/api/cron/recover`) plus an
  opportunistic sweep on task creation catches tasks whose runner died without handing off.

Runner authentication uses a shared `INTERNAL_TASK_TOKEN` and constant-time comparison, never a user
session. The endpoint is excluded from the SPA rewrite and always reaches the function.

## GitHub App access (Phase 2)

`resolveGithubAuth()` is the single seam that decides how the agent may act on GitHub:

1. **App installation** — short-lived (1 h) installation tokens, scoped to the repositories the
   user installed the App on, revocable at any time. Tokens are cached in Firestore (encrypted) and
   in-memory, refreshed 5 minutes before expiry, and re-minted exactly once on a dead token.
2. **OAuth fallback** — the Phase 1 token, for deployments without an App and for users who have
   not installed it yet.

Install attribution never trusts the `installation_id` query parameter: GitHub's redirect carries a
signed, 15-minute `state` issued only to an authenticated session, and the App then re-reads the
installation from the API to confirm it belongs to this App. Webhooks are verified over the raw
body with `X-Hub-Signature-256` and keep the installation table in sync (`created`, `deleted`,
`suspend`, `unsuspend`).

## Verification

```bash
npm run typecheck    # API, SPA, build tooling and test configs
npm test             # unit and API tests
npm run build        # SPA bundle
npm run check:node   # the Vercel handler loads on plain Node
npm run verify       # all of the above
```

Tests cover the patch policy, the no-deletion invariant, stale-base detection, context budgeting,
token envelope encryption, model-output parsing, quota windows, API routing/auth gates, the
pipeline (step order, replay safety, refund-on-our-failure, no-refund-on-conflict), the inline step
runner (retries, deadline handoff), runner selection and HTTP dispatch, runner/cron endpoint auth,
App JWT claims, install-state signing, webhook HMAC verification, installation-token caching, the
App-vs-OAuth resolution order, the multi-problem error contract (every violation reported at once)
and the regression that a wildcard auth middleware must not guard the runner, cron or webhook.

Local end-to-end checks against the Node API server: `/api/health`, `/api/config`, 401s for
missing/bad-signature/wrong-issuer JWTs, `/api/*` 404 JSON, and runner/cron 401 and 422 responses.

The SPA is covered by unit tests too: the client Firebase bootstrap (no raw `app/no-app` error,
idempotent initialisation) and the setup checklist screen (every variable rendered, missing ones
marked, no secret value ever rendered).

Not covered without live credentials: real Firestore reads/writes and index deployment, a full
GitHub OAuth round trip, a real App installation + token mint, webhook-driven DB writes, and an actual
commit. The browser UI is not exercised by automated tests.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Walking skeleton: SPA, API, Firebase auth, health/config | Done |
| 1 | Quota, durable agent, atomic commits, timeline, commit link | Done |
| 2 | GitHub App install tokens, signed install state, webhooks, token cache | Done |
| 2.5 | Vercel runtime: step runner, leases, HTTP dispatch, cron recovery | Done |
| 3 | Repo file browser, live streaming progress, retry failed tasks, preview builds, PR review comments, per-user token budget | Deferred |
| 4 | Team workspaces, Stripe billing, usage analytics | Deferred |

## Repo layout

```
api/               Vercel catch-all function entry
server/            API: routes, auth, db, agent, github, pipeline, platform
scripts/           Local Node API server
src/               SPA: pages, components, lib
shared/            Wire types shared by API and SPA
firebase/          Firestore rules, composite indexes, setup walkthrough
tests/             Vitest suites
docs/              Architecture notes
vercel.json        Function routing, SPA fallback, cron, maxDuration
```
