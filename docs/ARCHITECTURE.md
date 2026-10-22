# OpenMi architecture

This document explains *why* the system is shaped this way. The README covers *what* it does.

## Request path

```
POST /api/tasks
  ├─ verify Firebase ID token (firebase-admin, JWKS-cached)
  ├─ load project (owner-scoped)                  -> 404 if not yours
  ├─ require stored GitHub credential            -> 409 GITHUB_NOT_CONNECTED
  ├─ count active tasks                          -> 429 TOO_MANY_RUNNING_TASKS
  ├─ consumeTaskQuota(user, limit)  [Firestore transaction] -> 429 QUOTA_EXCEEDED
  ├─ create tasks doc (status=queued)
  ├─ startTaskRun(): POST /api/internal/run-task (self-dispatch, 202)
  └─ 202 { task, quota }
```

The response returns before any model call happens. The phone can go to sleep immediately.

On Vercel the dispatch is a self-invocation of the same function: the runner endpoint answers `202`
immediately, then executes the pipeline, bounded by `maxDuration`.

## One pipeline, one runtime

`server/agent/pipeline.ts` is the heart of the product; it knows nothing about a platform. It takes
a `StepRunner` (`server/agent/step-runner.ts`) — the inline implementation with bounded retries,
exponential backoff and a wall-clock deadline.

Steps:

| Step | What it does | Idempotency guard |
| --- | --- | --- |
| `claim task` | queued → running, takes the lease, verifies GitHub link | Skips terminal tasks; lease update is atomic |
| `resolve base commit` | pins `baseSha` + tree sha of the branch head | Immutable base, stored on the doc |
| `read repository context` | bounded file selection, contents fetched by blob sha | Pure read |
| `generate patch set` | model call + schema/policy validation, patch stored in Firestore | Writes a full patch set, replaceable |
| `commit to github` | one atomic commit, then marks the task succeeded | Skips if `commitSha` already set |
| `finalize task` | timeline event | Append-only |

Failure handling is itself a step: it records the error, writes a timeline entry, and refunds the
quota only for failures that were ours (`CONFIG_ERROR`, `AI_*`, `GITHUB_AUTH_EXPIRED`,
`GITHUB_UNAVAILABLE`, `INTERNAL`). A task that already committed is never marked failed.

### Durable execution without an engine

Vercel has no workflow engine, so durability is a property of the data rather than the runtime:

- **Lease.** `leaseTask` flips `queued → running` and stamps `leaseExpiresAt` in one conditional
  Firestore transaction; only the winner runs. A second invocation sees a live lease and exits.
  Expired leases are fair game, which is what makes crash recovery possible.
- **Resumption markers.** The pinned base sha, the stored patch set and `commitSha` are write-once
  guards. Every stage reads the doc first and skips what already happened, so any invocation can
  pick up any partially completed task.
- **Deadline handoff.** `RUN_BUDGET_SECONDS` (default 50) is the invocation's budget, clamped to
  `MAX_FUNCTION_DURATION - 10` so it can never outlive the function's own `maxDuration` (60 s) —
  an invocation that is killed at the platform limit never releases its lease, and the task would
  hang until the cron sweep picks it up. When a step would exceed the budget, the runner throws
  `DeadlineExceededError` *before* starting the step, the lease is released, and a new invocation
  is dispatched with a fresh budget. Work already persisted is not repeated.
- **Recovery.** A daily Vercel Cron hits `/api/cron/recover`, which finds tasks whose lease expired
  or which were never claimed, and re-dispatches them. Task creation also triggers a bounded sweep
  so a daily cron is not the only safety net.
- **Dispatch auth.** The runner endpoint trusts only `INTERNAL_TASK_TOKEN`, compared in constant
  time. It is not behind the user-session middleware and never accepts a browser session.

### Why step return values stay small

Step results are capped and re-fetched after a Vercel re-dispatch. So:

- The GitHub token is **never** returned from a step; it is decrypted from Firestore inside each
  step that needs it.
- Full file contents live in `tasks.patch`, not in step state.
- The repo tree is re-fetched by pinned sha where needed instead of being carried through.

### Fail-fast versus retry

`AppError.retryable` drives a single classification point. Non-retryable business/policy failures
are short-circuited by the inline runner, so neither burns retries — and, in the AI step, neither
burns money — on something that cannot succeed. Transient failures (DB blips, provider 5xx) use
exponential backoff.

### The model layer is a chain, not a single call

Providers retire model slugs without notice, so a single hard-coded model id is a single point of
failure. `buildProviderChain()` assembles the order per call: the configured OpenRouter model, its
fallback slugs, then the Groq model when a Groq key is present. Each attempt is classified by HTTP
status (`classifyProviderStatus`): 404 means the slug is gone — recorded and skipped; 401/403 means
the key is wrong — the chain stops, because no other model will fix it; 429 and 5xx are transient —
the next model is tried. Only when the whole chain fails does the task fail, and the error carries
one issue per attempt, so the timeline shows exactly which model died and why.

### Errors carry every problem, not the first one

`AppError.issues` is the shared contract. Request validation, patch policy, conflict detection and
configuration checks all collect their violations before throwing, and `summarizeIssues` renders a
one-line summary of the whole set. The alternative — throwing on the first violation — cost a round
trip per problem and hid the rest of the damage: a model that returned three unsafe paths had to
learn about them one regeneration at a time. The list is persisted on the task document
(`errorIssues`), attached to the timeline event, and rendered by the SPA as a list.

## Trust boundaries

1. **Browser → Function.** Verified Firebase Auth ID token only. `firebase-admin`'s
   `verifyIdToken` validates signature, issuer, audience and expiry against Google's cached public
   keys. Malformed tokens are rejected by a local shape check before any network call. No token is
   ever trusted for identity fields supplied by the client.
2. **Function → Firestore.** Admin SDK (service account). Firestore security rules deny all client
   access, so even a leaked web config cannot read stored tokens. Every query is additionally
   scoped by `ownerId`.
3. **Function → GitHub.** The user's OAuth token or App installation token, encrypted at rest with
   AES-256-GCM (random IV per record, key from an environment secret). Only used inside pipeline
   steps; never logged, never returned.
4. **Model output.** Untrusted by construction. Every file path passes `assertSafePath`, every
   operation is reconciled against the real tree, and content is size-checked before a blob exists.
5. **GitHub App webhooks.** Verified with HMAC over the raw body and matched against the configured
   `appId` before any database write.

## GitHub commit protocol

`server/github/commit.ts` implements "one prompt, one commit, no surprises":

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

`server/github/auth.ts` is the only place that answers "how may this user's agent write to GitHub?":

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
in-memory `Map` (free, warm) and Firestore with AES-256-GCM ciphertext (shared across isolates,
which matters because every invocation may land elsewhere). Concurrent cold misses are collapsed
with an in-memory single-flight promise, and a token is treated as stale five minutes before its
`expiresAt`. A rejected token is evicted and re-minted once; tokens are opaque, never parsed.

### Webhooks

`POST /api/webhooks/github` is public by necessity and authenticates itself: HMAC-SHA-256 over the
raw body, compared in constant time. Only the `installation` event is acted on, and the payload's
`appId` must match the configured App. `created` keeps an existing user link instead of clearing
it, because the webhook can arrive before the browser callback.

## Data model

```
profiles             1:1 with Firebase Auth uid
github_credentials   1:1 with uid; OAuth ciphertext + scopes (fallback path)
github_installations App installations; userId nullable until the callback claims it
github_installation_tokens  encrypted 1h tokens, keyed by installation
projects             ownerId, repoFullName (unique per owner), defaultBranch, commitMode
tasks                prompt, status, pinned base, patch, commit info, error, token usage
task_events          append-only timeline (subcollection, ordered by createdAt)
usage_daily          (userId, day) counters; the quota ledger
```

`tasks.leaseExpiresAt` is the ownership marker used by the serverless runner (see
[Durable execution without an engine](#durable-execution-without-an-engine)).

`usage_daily` is the single source of truth for budget. The Firestore transaction does the check
and increment in one atomic operation; a separate doc-per-day key makes the "resets at midnight
UTC" promise trivial and keeps historical usage for future analytics.

## Frontend

- No router dependency: ~30 lines of `history` handling for a handful of screens.
- All reads go through the Function API, so the SPA never needs to know collection shapes, and
  every query is owner-scoped server-side.
- Polling is conditional: only while a task is `queued`/`running`. No idle battery drain.
- Runtime config (`/api/config`) means one build artifact works against any environment.
- Auth: Firebase Auth (Google provider). The GitHub `provider_token` from the linked GitHub
  provider is sent to `/api/github/link` once, immediately after link, because Firebase only
  exposes it on the initial link result.

## Deliberate deferrals

| Deferred | Reason | Migration path |
| --- | --- | --- |
| ~~GitHub App tokens~~ | Done in Phase 2 | `resolveGithubAuth` prefers installations; OAuth is the fallback |
| Repo-wide context (embeddings) | Phase 1 repos are small; deterministic selection is cheaper | Add a vector index step before `generate patch set` |
| Streaming progress | Polling is enough at ≤5 tasks/day | SSE; the timeline collection already models the data |
| Diff-based patches | Full-file content is safer for small models | Keep full-file output, add diff application only for large files |
| Multi-file semantic verification | Needs a build sandbox | Phase 3 build step per project |

## Known constraints

- The AI step must complete within one step attempt (within `RUN_BUDGET_SECONDS` on Vercel). Large
  refactors need task splitting.
- Vercel self-dispatch requires the deployment to be reachable by the function itself; deployments
  behind Vercel Authentication need `INTERNAL_DISPATCH_URL` or must run on Production.
- Cron runs at most daily on the Hobby plan, so recovery latency between cron sweeps relies on the
  opportunistic sweep at task creation and on the deadline handoff.
- Repos with an enormous tree rely on GitHub's `base_tree` semantics and a truncated-tree fallback
  check. The full superset assertion is skipped (and logged) when the base tree comes back truncated.
- The SPA bundle includes the Firebase client SDK (auth only; no Firestore client — all data flows
  through the API). Route-level code splitting is the obvious next optimization.
- Octokit adds to the function bundle size; on Vercel this only affects cold starts.
