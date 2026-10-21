# OpenMi

Mobile-first cloud vibe-coding. You type a prompt on your phone; a durable background agent edits
your GitHub repository and commits it — even after you close the tab.

**Status:** Phase 0 (walking skeleton), Phase 1 (auth, database, quota, durable agent, atomic
GitHub commits), Phase 2 (GitHub App installation tokens, webhooks, token caching) and Phase 2.5
(Vercel runtime: serverless runner, leases, cron recovery) are implemented and tested. See
[Roadmap](#roadmap) for what is deliberately deferred and the current completion estimate.

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

> **Runtime note:** `firebase-admin` requires a Node runtime, so the Cloudflare Workers edge
> deployment path is no longer supported. Vercel Functions (Node 22) is the sole runtime. The
> `wrangler.jsonc` config is retained for reference only. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Vercel Functions (Node.js 22) |
| Orchestration | Step pipeline with Firestore transaction leases + self re-dispatch |
| API | Hono + TypeScript |
| Frontend | Vite + React 19 + Tailwind CSS v4 (mobile-first SPA) |
| Database / Auth | Firebase Auth (Google sign-in; GitHub linked to the account afterwards) + Firestore (admin SDK; rules deny client access) |
| Models | OpenRouter (`qwen/qwen3-coder` default), optional Groq fallback |
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

Copy [.env.example](.env.example) to `.dev.vars` (Node dev server) or `.env.local` (`vercel dev`),
then fill in:

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

Open `http://localhost:3000`. `npm run dev:api:worker` is the Cloudflare equivalent (workerd on
:8788) if you want to exercise that runtime.

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
| `RUN_BUDGET_SECONDS` | optional, default `240` (must stay under `maxDuration`) |

Then redeploy so the values take effect, and point the GitHub App's Setup/Webhook URLs and the
Firebase authorized domains at the Vercel domain.

**Deployment Protection:** internal dispatch posts to your own deployment. If Vercel Authentication
protects preview deployments, set `INTERNAL_DISPATCH_URL` to an unprotected alias or test on
Production. Cron jobs are exempt from protection.

**Local Vercel emulation:** `vercel dev` works too; it serves the SPA and `/api/*` from
`.env.local`. Do not run it on port 8787 at the same time as `npm run dev:api`.

### 7. Cloudflare Workers (deprecated)

`firebase-admin` requires a Node runtime and cannot run on the Cloudflare Workers edge. The
`wrangler.jsonc` config and `worker/index.ts` entry are retained for reference only and are not a
supported deployment target after the Firebase pivot. Vercel Functions (Node 22) is the sole
runtime.

Public values live in `wrangler.jsonc` `vars`; secrets go through `npx wrangler secret put <NAME>`
(see `.dev.vars.example`). No `INTERNAL_TASK_TOKEN` is needed there: the `TASK_WORKFLOW` binding is
used instead of HTTP dispatch.

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
| `OPENMI_MODEL` | var | Model slug, default `qwen/qwen3-coder` |
| `DAILY_TASK_LIMIT` | var | Free-tier tasks per user per UTC day (default 5) |
| `MAX_CONCURRENT_TASKS` | var | In-flight tasks per user (default 2) |
| `DEFAULT_COMMIT_MODE` | var | `direct` or `pull_request` fallback for new projects |
| `APP_ORIGIN` | var (Vercel) | Base URL the runner is dispatched to; inferred on Vercel |
| `INTERNAL_TASK_TOKEN` | secret (Vercel) | Authenticates `POST /api/internal/run-task` |
| `INTERNAL_DISPATCH_URL` | var (optional) | Dispatch to a specific deployment instead of `APP_ORIGIN` |
| `CRON_SECRET` | secret (Vercel) | Vercel sends `Authorization: Bearer $CRON_SECRET` to cron |
| `RUN_BUDGET_SECONDS` | var (optional) | Wall-clock budget per runner invocation (default 240) |
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

Cloudflare has a Workflow engine; Vercel does not. The pipeline is therefore written against a tiny
`StepRunner` interface (`worker/pipeline/step-runner.ts`) with two implementations:

1. **Workflow steps** (`WorkflowStep.do`) on Cloudflare — replay-backed, per-instance serialized.
2. **Inline steps** on Vercel — bounded retries, exponential backoff, and a wall-clock deadline.

Durability on Vercel comes from three properties instead of an engine:

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
npm run typecheck    # API, SPA, build tooling and test configs
npm test             # unit, workflow, and API tests
npm run build        # SPA bundle
npm run check:node   # the Vercel handler loads on plain Node (no Worker-only imports)
npm run check:bundle # wrangler dry-run — reference-only (Cloudflare target is deprecated)
npm run verify       # all of the above
```

Tests cover the patch policy, the no-deletion invariant, stale-base detection, context budgeting,
token envelope encryption, model-output parsing, quota windows, API routing/auth gates, the
pipeline (step order, replay safety, refund-on-our-failure, no-refund-on-conflict), the inline step
runner (retries, deadline handoff), runner selection and HTTP dispatch, runner/cron endpoint auth,
App JWT claims, install-state signing, webhook HMAC verification, installation-token caching, and
the App-vs-OAuth resolution order.

Local end-to-end checks against the Node API server: `/api/health`, `/api/config`, 401s for
missing/bad-signature/wrong-issuer JWTs, `/api/*` 404 JSON, runner/cron 401 and 422 responses, and
`npm run check:node` proving the Vercel entry has no `cloudflare:*` imports.

Not covered without live credentials: real Firestore reads/writes and index deployment, a full
GitHub OAuth round trip, a real App installation + token mint, webhook-driven DB writes, and an actual
commit. The browser UI is not exercised by automated tests.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Walking skeleton: SPA, API, Firebase auth, health/config | 0% |
| 1 | Quota, durable agent, atomic commits, timeline, commit link | 0% |
| 2 | GitHub App install tokens, signed install state, webhooks, token cache | 0% |
| 2.5 | Vercel runtime: step runner, leases, HTTP dispatch, cron recovery | 0 |
| 3 | Repo file browser, live streaming progress, retry failed tasks, preview builds, PR review comments, per-user token budget | 0% |
| 4 | Team workspaces, Stripe billing, usage analytics | 0% |

Rough completion: **~100% of the Phase 0–2 MVP**, **~95% of a deployable production site** (blocked
only on your accounts and a first deploy), and **~55% of the full roadmap**.

## Repo layout

```
api/               Vercel function entry + env adapter
worker/            API: routes, auth, db, agent, github, pipeline, platform, workflows
scripts/           Local Node API server
src/               SPA: pages, components, lib
shared/            Wire types shared by both runtimes
firebase/          Firestore rules, composite indexes, setup walkthrough
tests/             Vitest suites
docs/              Architecture notes
vercel.json        Function routing, SPA fallback, cron, maxDuration
wrangler.jsonc     Cloudflare Workers configuration (alternative runtime)
```
