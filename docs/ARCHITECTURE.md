# OpenMi architecture

This document explains *why* the system is shaped this way. The README covers *what* it does.

## Request path

```
POST /api/tasks
  ├─ verify Supabase JWT (local, JWKS-cached)
  ├─ load project (owner-scoped)                  -> 404 if not yours
  ├─ require stored GitHub credential            -> 409 GITHUB_NOT_CONNECTED
  ├─ count active tasks                          -> 429 TOO_MANY_RUNNING_TASKS
  ├─ consume_task_quota(user, limit)  [atomic SQL]-> 429 QUOTA_EXCEEDED
  ├─ INSERT tasks row (status=queued)
  ├─ env.TASK_WORKFLOW.create({ taskId, userId, projectId })
  └─ 202 { task, quota }
```

The response returns before any model call happens. The phone can go to sleep immediately.

## Durable workflow

`worker/workflows/task-workflow.ts` is the heart of the product. Steps:

| Step | What it does | Idempotency guard |
| --- | --- | --- |
| `claim task` | queued → running, verifies GitHub link | Skips terminal tasks |
| `resolve base commit` | pins `baseSha` + tree sha of the branch head | Immutable base, stored on the row |
| `read repository context` | bounded file selection, contents fetched by blob sha | Pure read |
| `generate patch set` | model call + schema/policy validation, patch stored in Postgres | Writes a full patch set, replaceable |
| `commit to github` | one atomic commit, then marks the task succeeded | Skips if `commit_sha` already set |
| `finalize task` | timeline event | Append-only |

Failure handling is itself a step: it records the error, writes a timeline entry, and refunds the
quota only for failures that were ours (`CONFIG_ERROR`, `AI_*`, `GITHUB_AUTH_EXPIRED`,
`GITHUB_UNAVAILABLE`, `INTERNAL`). A task that already committed is never marked failed.

### Why step return values stay small

Workflow state is capped (~1 MiB per step result) and is replayed on recovery. So:

- The GitHub token is **never** returned from a step; it is decrypted from Postgres inside each step
  that needs it.
- Full file contents live in `tasks.patch` (jsonb), not in step state.
- The repo tree is re-fetched by pinned sha where needed instead of being carried through.

### Fail-fast versus retry

`AppError.retryable` drives a single classification point. Non-retryable business/policy failures
are rethrown as `NonRetryableError` (from `cloudflare:workflows`) so the engine does not burn
retries — and, in the AI step, does not burn money — on something that cannot succeed. Transient
failures (DB blips, provider 5xx) use exponential backoff.

## Trust boundaries

1. **Browser → Worker.** Verified Supabase JWT only. Asymmetric keys (ES256/RS256) via the project
   JWKS; algorithms are pinned per branch, and HS256 exists solely for local tests behind
   `SUPABASE_JWT_SECRET`. Issuer and audience are validated. No token is ever trusted for identity
   fields supplied by the client.
2. **Worker → Postgres.** Service role, and every query is additionally scoped by `owner_id`. RLS is
   enabled anyway: `github_credentials` is `select … using (false)` for clients, so a leaked anon key
   cannot read stored tokens.
3. **Worker → GitHub.** The user's OAuth token, encrypted at rest with AES-256-GCM (random IV per
   record, key from Worker secret). Only used inside workflow steps; never logged, never returned.
4. **Model output.** Untrusted by construction. Every file path passes `assertSafePath`, every
   operation is reconciled against the real tree, and content is size-checked before a blob exists.
5. **GitHub App webhooks.** Verified with HMAC over the raw body and matched against the configured
   `app_id` before any database write.

## GitHub commit protocol

`worker/github/commit.ts` implements "one prompt, one commit, no surprises":

1. Read base commit → tree sha → full tree (recursive).
2. `assertPatchTargets` — updates must still exist and carry the same blob sha as the snapshot.
   A human edit during generation produces `GITHUB_CONFLICT` rather than a silent overwrite.
3. Create blobs for each file (never mutate existing blobs).
4. `POST /git/trees` with `base_tree` — GitHub retains everything we did not name.
5. Fetch the new tree and assert it is a superset of the base tree; assert every patched path is
   present. Only then create the commit.
6. `PATCH /git/refs/heads/<branch>` with `force: false`. Non-fast-forward updates are rejected by
   GitHub regardless of our own logic — the final backstop against history rewriting.
7. `pull_request` mode instead creates `openmi/task-<id>` and a PR, leaving the base branch alone.

## GitHub App authentication (Phase 2)

### Resolution order

`worker/github/auth.ts` is the only place that answers "how may this user's agent write to GitHub?":

```
App configured? -> installation for user? -> not suspended? -> installation token (1h)
                                  |
                                  +-- missing/suspended/dead --> OAuth credential
```

Transient failures (`GITHUB_UNAVAILABLE`, rate limits) propagate instead of silently downgrading to
OAuth, so a GitHub outage cannot masquerade as "no installation". A revoked installation
(`GITHUB_AUTH_EXPIRED` / `GITHUB_NOT_FOUND`) does fall back when an OAuth token exists.

### Trust of the install callback

GitHub warns that the `installation_id` query parameter on the setup redirect can be spoofed, so
attribution uses a different channel: `POST /api/github/app/install` (authenticated) returns an
install URL carrying an HMAC-signed state `{userId, expiry, nonce}` (15 min). The public callback
verifies that state, then re-reads the installation from `/app/installations/{id}` with an App JWT
to confirm this App owns it before linking it to the user. Without the signed state an attacker
could bind somebody else's installation to their own account.

### Token lifecycle

Installation tokens last ~1 hour and may be reused concurrently. They are cached at two levels:
per-isolate `Map` (free, warm) and Postgres with AES-256-GCM ciphertext (shared across isolates,
which matters because every Workflow step may land elsewhere). Concurrent cold misses are collapsed
with an in-isolate single-flight promise, and a token is treated as stale five minutes before its
`expires_at`. A rejected token is evicted and re-minted once; tokens are opaque, never parsed.

### Webhooks

`POST /api/webhooks/github` is public by necessity and authenticates itself: HMAC-SHA-256 over the
raw body, compared with `crypto.subtle.verify` (constant time). Only the `installation` event is
acted on, and the payload's `app_id` must match the configured App. `created` keeps an existing
user link instead of clearing it, because the webhook can arrive before the browser callback.

## Data model

```
profiles             1:1 with auth.users
github_credentials   1:1 with auth.users; OAuth ciphertext + scopes (fallback path)
github_installations App installations; user_id nullable until the callback claims it
github_installation_tokens  encrypted 1h tokens, keyed by installation
projects           owner_id, repo_full_name (unique per owner), default_branch, commit_mode
tasks              prompt, status, pinned base, patch jsonb, commit info, error, token usage
task_events        append-only timeline (ordered by identity column)
usage_daily        (user_id, day) counters; the quota ledger
```

`usage_daily` is the single source of truth for budget. The RPC does the check and increment in one
statement; a separate row-per-day key makes the "resets at midnight UTC" promise trivial and keeps
historical usage for future analytics.

## Frontend

- No router dependency: ~30 lines of `history` handling for three screens.
- All reads go through the Worker API, so the SPA never needs to know table shapes, and every query
  is owner-scoped server-side.
- Polling is conditional: only while a task is `queued`/`running`. No idle battery drain.
- Runtime config (`/api/config`) means one build artifact works against any environment.
- Auth: Supabase PKCE. The GitHub `provider_token` is sent to `/api/github/link` once, immediately
  after sign-in, because Supabase only exposes it on the initial session.

## Deliberate deferrals

| Deferred | Reason | Migration path |
| --- | --- | --- |
| ~~GitHub App tokens~~ | Done in Phase 2 | `resolveGithubAuth` prefers installations; OAuth is the fallback |
| Repo-wide context (embeddings) | Phase 1 repos are small; deterministic selection is cheaper | Add a vector index step before `generate patch set` |
| Streaming progress | Polling is enough at ≤5 tasks/day | Workflow events + SSE; the timeline table already models the data |
| Diff-based patches | Full-file content is safer for small models | Keep full-file output, add diff application only for large files |
| Multi-file semantic verification | Needs a build sandbox | Phase 3 build step with `wrangler dev` per project |

## Known constraints

- The AI step must complete within one step attempt (6 min timeout). Large refactors need task
  splitting; that is a Phase 2 feature.
- Repos with an enormous tree rely on GitHub's `base_tree` semantics and a truncated-tree fallback
  check. The full superset assertion is skipped (and logged) when the base tree comes back truncated.
- The SPA bundle includes `@supabase/supabase-js` (~470 KB raw / 133 KB gzipped). Route-level code
  splitting is the obvious next optimization.
- Octokit pushes the Worker bundle to ~336 KB gzipped, under the Workers limit but worth watching.
