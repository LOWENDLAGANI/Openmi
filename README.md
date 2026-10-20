# OpenMi

Mobile-first cloud vibe-coding. You type a prompt on your phone; a durable background agent edits
your GitHub repository and commits it — even after you close the tab.

**Status:** Phase 0 (walking skeleton) and Phase 1 (auth, database, quota, durable agent,
atomic GitHub commits) are implemented. See [Roadmap](#roadmap) for what is deliberately deferred.

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

## API

All routes are under `/api`. Everything except `/api/health` and `/api/config` requires
`Authorization: Bearer <supabase access token>`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness + which config keys are missing (never values) |
| `GET` | `/api/config` | Public runtime config for the SPA |
| `GET` | `/api/me` | Profile, GitHub link state, remaining daily quota |
| `POST` | `/api/github/link` | Store the OAuth token (encrypted) from sign-in |
| `GET` | `/api/github/repos` | Repositories the token can write to |
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

## Verification

```bash
npm run typecheck    # worker, SPA, and build-tool configs
npm test             # 60 unit, workflow, and API tests
npm run build        # SPA bundle
npm run check:bundle # wrangler dry-run: Worker + Workflows + assets
npm run verify       # all of the above
```

Tests cover the patch policy, the no-deletion invariant, stale-base detection, context budgeting,
token envelope encryption, model-output parsing, quota windows, API routing/auth gates, and the
workflow pipeline itself (step order, replay safety, refund-on-our-failure, no-refund-on-conflict).

Local end-to-end checks against `wrangler dev` (real `workerd`): `/api/health`, `/api/config`,
401s for missing/bad-signature/wrong-issuer JWTs, `/api/*` 404 JSON, SPA deep-link fallback, and
static asset serving.

Not covered without live credentials: real Supabase reads/writes, a full GitHub OAuth round trip,
and an actual commit. Those are the first things to exercise once secrets are configured.

## Roadmap

- **Phase 2** — GitHub App installation tokens (per-repo, revocable) instead of OAuth tokens;
  repository file browser; re-run failed tasks; per-user token/streaming budget.
- **Phase 3** — streaming agent progress (Workflows + SSE), multi-file preview builds, PR review
  comments, project templates.
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
