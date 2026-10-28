# Openmi Repo Agent — overhaul specification

Status: **Phase 2 complete** — the shippable MVP is built: proposals, derived
diffs, the review screen, the approval record and the single commit endpoint
that opens a pull request. Phase 3 is deferred. This document is the contract for
Phases 1–3; §7.4 and §8.1 record where the implementation deliberately differs.
Working name: **Openmi**. The name lives in `lib/brand.ts`; renaming is a one-line
change plus a storage-key migration.

---

## 1. What this product is

A browser workspace where a person talks to an AI agent about a GitHub
repository. The agent reads code, explains it, and **proposes** changes. A change
is committed to GitHub only after the person explicitly approves it, on a branch
the agent owns.

What it is **not**, in v1:

- Not a chat app with a coding persona. The product's value is repository access.
- Not an app builder. There is no "generate a whole app from nothing" flow.
- Not an executor. No sandbox, no `npm test`, no preview server. The agent cannot
  run code it writes; it says so rather than implying otherwise.
- Not a vendor-hiding product. The identity firewall is gone; the agent may name
  models and providers honestly.

## 2. Locked decisions (from the product owner)

| # | Decision |
|---|---|
| 1 | This repository is transformed in place; Openmi's history stays for forensics. |
| 2 | **Commit only.** No sandbox, no execution, no preview in v1. |
| 3 | **Google is the primary account.** GitHub is an optional authorisation, requested only when the user wants repository features. |
| 4 | **Branch policy:** commits go to a new `agent/*` branch and a pull request is opened. Never to the default branch, unless the user changes a setting. |
| 5 | **Dew currency carries over.** Pricing becomes **flat per request, per model**. Token counts are still recorded and displayed, but do not price the request. Multiple models later, each with its own price. |

## 3. What Phase 0 removed (already done)

Deleted, with their tests and routes:

- Google tools: `lib/googleTools.ts`, `lib/googleAuth.ts`, `lib/googleStatus.ts`,
  `app/api/google/*`, `components/GoogleToolsSection.tsx`.
- Image generation: `lib/imageGeneration.ts`, `app/api/image`, poster/share-image
  rendering, `components/GalleryOverlay.tsx`, `lib/gallery.ts`.
- Notes: `lib/notes.ts`, `app/notes/*`, `NotesFeed`, `NotesPrompt`, `AdminNotes`.
- Memory: `lib/memory*.ts`, `app/api/memory`, `MemoryPanel`, `MemorySuggestions`.
- Read-aloud (`lib/tts.ts`), send-later (`lib/scheduler.ts`), share links
  (`lib/shareLink.ts`, `app/share`), the Gradio Space adapter (`lib/gradioSpace.ts`),
  and the identity firewall (`lib/identity.ts`).
- Dexie v5 drops the `memories` and `scheduled` tables.

Kept and still green: chat shell (thread, composer, sidebar, search palette,
folders, trash, temporary chats), streaming provider fallback, continuation on
truncation, local-first Dexie history + Firebase sync, visitor name and Google
link, Dew wallet, redeem codes, admin console, push, PWA, Sentry, rate limiting.

## 4. Pricing

`lib/dew.ts` is the single source of truth.

> **Corrected 2026-10-28.** The flat per-request price this section originally
> specified was replaced before launch. What shipped is billing by the hour:
> one purchase covers every message on one model for sixty minutes.

```ts
export const DEW_PER_HOUR = 3;
export const HOUR_SESSION_MS = 60 * 60 * 1000;
export const DAILY_FREE_DEW = 10;      // PAID_DAILY_FREE_DEW = 15
export const TRIAL_DEW = 5;
```

- Starting an hour charges 3 Dew once, server-side, in `start_hour_session()`.
  Every message inside that hour is free, in every chat.
- An hour is bound to the model it was bought for and, when it was started in a
  repository, to that repository. Asking for a different model or repository is
  refused with the live hour named, never silently re-scoped.
- One live hour per account. A second start while one is live is refused, so two
  tabs cannot each open and pay for their own.
- The free daily bucket is spent before paid credit and refills at midnight in
  the account's timezone. A paid pass raises it to 15 Dew. Unused free Dew does
  not carry over; trial, redeemed and topped-up Dew never expires.
- Token counts are still emitted (`usage`), stored on the message and recorded,
  but they no longer price anything. They are telemetry, not the bill.
- Adding a model = one entry in `lib/models.ts` plus its engine in
  `lib/modelEngines.ts`; the price does not change, because time is what is sold.

**Agent turns.** An agent step draws on the same hour as chat, so the caps bound
cost rather than price: `MAX_STEPS` (8) and `MAX_TURN_TOKENS` (60k), enforced
server-side by a signed turn blob, never by the client. A turn that hits a cap
says so; the next message is simply another message in the same hour.

## 5. Accounts and GitHub

- **Supabase Auth is the identity** (corrected 2026-10-28): Google, GitHub,
  Microsoft, or an email address and password. Every request carries the
  account's own JWT and PostgreSQL row-level security decides access; Firebase
  is no longer used. See `docs/MIGRATE_TO_SUPABASE.md`.
- GitHub is **authorization, not identity**. A personal access token or the
  OAuth App flow attaches a credential to the existing account; the account id
  is unchanged.
- Server stores the token encrypted (AES-256-GCM, key from `GITHUB_TOKEN_KEY`) in
  the caller's own `github_connections` rows, never in the client bundle, never
  in a cookie the browser can read.
- Risk: Firebase's GitHub credential does not refresh indefinitely. When a commit
  fails with 401, the UI asks the user to reconnect GitHub; it never silently
  retries with another account. If this becomes common, replace the link with a
  dedicated GitHub OAuth App with expiring tokens (`GITHUB_CLIENT_ID`,
  `GITHUB_CLIENT_SECRET`) — the token store and the rest of the code do not change.

## 6. Repository access

Server-only modules under `lib/github/`:

| Module | Responsibility |
|---|---|
| `client.ts` | Thin REST wrapper: base URL, auth header, 403/429 handling, `X-RateLimit-Reset`. |
| `oauth.ts` | Link/callback/status/revoke for the GitHub credential. |
| `pat.ts` | Checks a pasted personal token against `GET /user` and one repository listing. |
| `connections.ts` | The stored connections: seal, open, rotate, default, revoke. |
| `store.ts` | Which connection a request may use. |
| `tree.ts` | Tree at a commit SHA, `.gitignore`-aware filtering, per-file size caps. |
| `search.ts` | Lexical scan over cached blobs, ranked and capped. |
| `cache.ts` | In-process tree and blob caches, keyed by repository, commit and blob SHA. |
| `commit.ts` | Blobs → tree (with `base_tree`) → commit → ref, then PR. |

Read path rules:

- Every request names `{owner}/{repo}` and a `base_sha`. Nothing reads "latest"
  implicitly except the initial repo selection.
- Paths are validated against the tree before a blob is fetched; no `..`, no
  absolute paths, no URLs from the model.
- A repository with no push permission is readable but never committable; the
  commit endpoint re-checks permission server-side.
- Rate limits: authenticated REST is 5,000 req/h; code search is far stricter.
  v1 does not use GitHub code search — the tree plus in-memory lexical ranking is
  the retrieval layer.

## 7. The agent

### 7.1 Tools (native function calling)

The current chat route has **no** native tool calling. Phase 1 replaces the
prompt-driven action blocks with OpenAI-compatible `tools` / `tool_calls`.

| Tool | Input | Behaviour |
|---|---|---|
| `list_files` | `path?`, `depth?` | Filtered tree slice, capped at 200 paths. |
| `read_file` | `path` | Whole file up to 200 KB, then a truncation note. Binary is refused, not decoded. |
| `search_code` | `query`, `path?` | Lexical scan over cached blobs; returns path + line + snippet. |
| `propose_edits` | `edits[]` | The only write-ish tool. Validates and stages; never commits. **Shipped in Phase 2**: `lib/agent/edits.ts` applies the edit in memory and derives the diff; the tool has no token and no client. |

`propose_edits` accepts two shapes:

1. `{ path, content }` — whole file (preferred under ~200 lines).
2. `{ path, old_string, new_string }` — unique replacement. The server rejects a
   match count other than exactly one. The model never emits diff syntax.

The server computes unified diffs from the applied result. Diffs are derived,
never trusted.

### 7.2 Loop and transport

- Client-driven stepping: `POST /api/agent/step` runs at most 2 tool rounds and
  returns the next state. This fits Vercel's `maxDuration = 120` and gives
  cancellation for free.
- The transcript is echoed by the client and re-validated on arrival (roles are
  an allowlist, every string capped, malformed entries dropped). The budget —
  steps used, tokens spent, whether the turn was paid — travels in an HMAC-signed
  blob (§7.4), so a forged transcript can lie about the conversation but not
  about what it has cost.
- Every step re-verifies the caller, re-reads the project from the caller's own
  database node, and re-opens the sealed GitHub token. A project id belonging to
  somebody else resolves to nothing.
- The turn ends when the model returns text with no tool call, `MAX_STEPS`, or
  the token cap.

### 7.3 Context budget

- The tree is fetched once per `base_sha` and cached in-process for two minutes
  (`lib/github/cache.ts`), keyed by repository and commit.
- File contents are cached by blob SHA, so a re-read is free and a changed file
  (new SHA) can never be served stale.
- The filtered tree is what the model sees and what the pane shows, from one
  function, so the two cannot disagree about which files exist.
- Tool results are capped (200 paths, 32 KB/file, 8 KB/search result) and older
  tool results are collapsed to a one-line summary when the budget is tight.
- No embeddings in v1. Lexical ranking over paths and symbols is enough for the
  first release; the retrieval interface is a single function so it can be
  swapped.

### 7.4 Where Phase 1 deviates from the plan

Two decisions changed while building, both for the same reason: this deployment
has no session store, only a rules-protected database and short-lived instances.

1. **Turn state is signed, not stored.** `lib/agent/turns.ts` carries the step
   count, token totals, project id and expiry in an HMAC-SHA256 blob that the
   client sends back and the server verifies on every step. Nothing in it is
   trusted without the signature: an edited blob starts a new, newly charged
   turn. The planned `turn_id` row would have needed a write path with no rule to
   protect it. The cost is a client that must keep the token; the benefit is no
   session table, no cleanup job, and one fewer place to leak a repository.
2. **The step cap is 8, not 12.** Every step is a full model call, and eight is
   the point where a flat 0.5 Dew charge still covers the measured average. A
   turn that hits the cap says so in the message rather than trimming silently,
   and `MAX_STEPS` / `MAX_TURN_TOKENS` live in one file, so raising them is one
   edit plus the pricing decision that goes with it.

Read caps are per call and server-side: 200 KB per file, 200 paths per
`list_files`, 10 candidate files per `search_code`, 20 hits per search.

## 8. Change review and the commit invariant

**Invariant:** the model has no tool that can write to GitHub. Writing exists in
exactly one endpoint, `POST /api/changesets/:id/commit`, which requires:

1. A verified caller (`verifyCaller`) and the same UID that created the change set.
2. A signed approval, bound to
   `(uid, repo, base_sha, changeset_hash, branch, message, created_at)`.
3. A re-check that the branch still points at `base_sha`. If it moved, the commit
   is refused with a re-diff, never merged blindly.
4. A server-side permission check (`push` on the repo) at commit time.
5. A commit record for the change set, so a double-click or a retried request
   cannot make two commits.

Change set lifecycle:

```
proposed → reviewed → approved → committed (sha) | rejected | stale
```

`approved` is written by the approve endpoint after a same-origin check. A typed
"yes, commit it" may *request* approval, but the UI always shows a final confirm
button; the model cannot approve its own proposal.

### 8.1 Signatures, because the rows cannot be trusted alone

The planned rules gave `turns`, `changesets`, `approvals` and `commits`
`.write: false` for the client and assumed a privileged server could still write
them. This deployment has no service account, so every write goes through the
caller's own token and the rules cannot distinguish the server's request from
the browser's. A rules-only store therefore cannot make a row mean "the server
approved this". The implementation says so and moves the authority to a
signature, in the same way §7.4 moved turn state out of a table:

- A change set is signed when it is proposed, over the id, repository, project,
  default branch, base commit, branch, message, file contents, creation time and
  expiry. `status` is deliberately outside the signature: it is the lifecycle
  label the endpoints move through, and a signed status would make every one of
  those writes invalidate the change. It grants nothing on its own.
- Reading a change set re-derives its hash from the stored files and compares it
  with the signed hash, so one changed byte in the row fails verification. The
  branch is re-derived from the id and repository for the same reason.
- The approval is signed over the change-set hash, base commit, branch,
  repository and id. `commitGate` requires that exact signature; a row claiming
  `approved` with no approval is refused (`no-approval`), and an approval that
  names a different hash is refused (`approval-mismatch`).
- The rows are the audit trail and what the review screen reads. They are not
  the permission.

Idempotency is a commit record plus a derived branch name rather than a separate
key: a repeat submit returns the recorded sha, and two racing requests can only
create one ref, because the second `POST /git/refs` is refused by GitHub (409)
and the route returns that refusal rather than a second commit.

Commit mechanics (Git Data API):

```
POST /git/blobs        (one per changed file)
POST /git/trees        { base_tree: base_sha_tree, tree: [...] }
POST /git/commits      { message, tree, parents: [base_sha], author }
POST /git/refs         (new branch refs/heads/agent/<slug> at the new commit)
POST /pulls            (optional; head agent/<slug>, base default branch)
```

The ref update is the atomic publish. A failure before it leaves no trace on the
repository.

## 9. Data model

Dexie (client, v6):

| Table | Key / indexes | Notes |
|---|---|---|
| `projects` | `id, repoFullName, updatedAt` | One per connected repo. |
| `turns` | `id, projectId, createdAt` | Agent runs, including step state summary. |
| `changesets` | `id, turnId, status, updatedAt` | Local mirror for review UI. |
| `chats`, `messages`, `folders`, `trash` | unchanged | Existing shell. |

Realtime Database (authoritative for anything that spends money or touches GitHub):

```
users/{uid}/github          { encryptedToken, login, scopes, linkedAt }
projects/{uid}/{repoId}     { repoFullName, defaultBranch, treeSha, updatedAt }
turns/{uid}/{turnId}        { projectId, baseSha, steps, tokens, state }
changesets/{uid}/{id}       { repoFullName, baseSha, branch, files, hash, status }
approvals/{uid}/{id}        { changesetId, repoFullName, baseSha, hash, branch, message, at }
commits/{uid}/{id}          { changesetId, sha, branch, prUrl, at }
```

`changesets`, `approvals` and `commits` are written by the server through the
caller's token, so the rules scope them to `auth.uid === $uid` and validate
their shape rather than forbidding the write outright — the deployment has no
service account to write them any other way. The signature in each record, not
the row, is what the approve and commit endpoints believe; see §8.1. `turns`
remains a signed blob rather than a table (§7.4).

## 10. API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/github/link` | POST | Start the link/authorization flow. |
| `/api/github/callback` | GET | Finish it; store the encrypted token. |
| `/api/github/status` | GET | Connected login + scopes; never the token. |
| `/api/github/repos` | GET | The user's repositories, paginated. |
| `/api/projects` | GET/POST | List/attach a repo; captures `base_sha` and tree. |
| `/api/projects/:id/tree` | GET | Filtered tree for the file pane. |
| `/api/projects/:id/file` | GET | File contents for the viewer, capped. |
| `/api/agent/step` | POST | One step of the loop; SSE or JSON. |
| `/api/changesets/:id` | GET | Files + server-computed diffs. |
| `/api/changesets/:id/approve` | POST | Writes the approval record. |
| `/api/changesets/:id/commit` | POST | The only write to GitHub. |
| `/api/chat` | POST | Existing chat, kept for conversation outside a repo. |

Every mutating route calls `isSameOriginRequest` and a per-user rate limit.

## 11. UI

The shell stays; the workspace is new.

- **Repo picker** — first screen after sign-in; lists repos, remembers the last.
- **File pane** — tree on the left of the thread, read-only viewer with syntax
  highlighting, opens the file the agent is talking about.
- **Agent steps** — a compact timeline inside the assistant message:
  `read src/app.tsx`, `searched "createChat"`, `3 files changed`. Never a wall of
  tool JSON.
- **Change review** — diff cards, per-file collapse, add/remove counts, and a
  single primary action: **Approve & commit**. Secondary: **Request changes**,
  **Discard**.
- **Commit result** — branch name, commit SHA, PR link, and "Undo" instructions
  (a revert PR, not a force-push).
- **Empty state** — the existing thread empty state, with copy about repositories.

## 12. Security checklist

- [ ] GitHub token encrypted at rest; never returned by any route.
- [ ] Every repo route scoped by verified UID, not a client-supplied id.
- [ ] Approval bound to a change-set hash; a stale approval cannot commit.
- [ ] Repository content treated as untrusted data in the prompt.
- [ ] No path traversal; paths resolved against the tree.
- [ ] Commit refuses a non-`agent/*` branch unless the setting is explicitly on.
- [ ] Idempotency key on commit.
- [ ] Same-origin check on approve/commit.
- [ ] Per-user rate limit and per-turn token/step cap.
- [ ] Audit row for every approval and commit.

## 13. Phases

### Phase 0 — strip and rebrand ✅
Deleted the domains above, rewrote the chat route without Google/memory/identity,
flat Dew pricing, hardened tests. Verified: `typecheck`, `lint`, `test`, `build`.

### Phase 1 — read-only repository agent ✅
Deliverables: GitHub link, repo picker, tree/file panes, native tool calling with
`list_files` / `read_file` / `search_code`, step timeline, server-side turn state.
Shipped as `lib/github/*`, `lib/agent/*`, `app/api/github/*`,
`app/api/projects/*`, `app/api/agent/step` and `components/RepoPanel.tsx`;
the rules for `users/{uid}/github` and `projects/{uid}` are in
`database.rules.json`. See §7.4 for the two deviations from the plan.

Acceptance:
- A user can link GitHub, pick a repo, and ask "where is the rate limiter?" and
  get an answer citing real paths and lines.
- No route can write to GitHub (grep test asserting no `PUT/POST` to content
  endpoints outside `commit.ts`).
- A turn stops at `MAX_STEPS` and says so.
- Tokens are recorded; one flat charge is deducted per turn.

### Phase 2 — propose, review, commit (shippable MVP)
Deliverables: `propose_edits`, diff computation, review UI, approval record,
commit + PR, commit history, audit rows.

Delivered:

- `propose_edits` (`lib/agent/edits.ts`), server-computed unified diffs, and the
  per-step staging returned by `/api/agent/step`.
- `lib/changesets.ts`: ids, hashes, `agent/` branch naming, signed change sets,
  signed approvals, the commit gate, and the stored records.
- `/api/agent/step` saves a signed change set when a step proposes one and
  returns its id; the id is stored on the message, so the review card survives a
  reload.
- `GET /api/changesets/:id`, `POST /api/changesets/:id/approve` and
  `POST /api/changesets/:id/commit`.
- `components/ChangeReview.tsx`: diff cards, per-file collapse, add/remove
  counts, **Approve & commit**, and the commit result (branch, sha, PR link).
- `lib/github/commit.ts`: blobs → tree on the base tree → commit → ref → PR, the
  only module in the product that writes to GitHub.
- Rules for `changesets/{uid}`, `approvals/{uid}` and `commits/{uid}` in
  `database.rules.json`.

Acceptance:
- The agent proposes a change; the user sees a correct unified diff. ✅
- Nothing is written until Approve; the commit endpoint refuses without an
  approval, and refuses when `base_sha` moved. ✅
- The commit lands on `agent/<slug>` and a PR opens against the default branch. ✅
- A double submit produces one commit. ✅ (recorded sha returned; the ref itself
  is the race barrier)
- An approved change set from another user's turn cannot be committed. ✅ (the
  row is read under the caller's uid; ids are content-derived and not enumerable
  across accounts)

### Phase 3 — execution (deferred)
Sandbox workspace: clone, install, test, build, dev-server preview. The tool
interface is already a `Workspace` port; this phase adds `SandboxWorkspace`
beside `GitHubWorkspace`. Requires a provider decision (E2B / Daytona / Modal /
Cloudflare Containers) and is explicitly out of v1.

## 14. Known risks

1. **Context quality.** A large repo will not fit. The lexical index is the first
   bet; if answers miss files, add symbol extraction before embeddings.
2. **GitHub token lifetime.** Firebase-linked GitHub credentials expire. The
   reconnect flow must be visible, not a silent failure.
3. **Cost per turn.** Twelve steps can be 60k tokens. The flat price must be set
   against measured average tokens, not guessed; the ledger keeps the numbers.
4. **Vercel time limit.** Client-driven stepping is a workaround, not a scheduler.
   If turns need to survive a closed tab, move to a durable job runner.
5. **Prompt injection via repository content.** A README can say "ignore your
   rules". The prompt treats repo text as data, and the commit invariant means an
   injected instruction still cannot write anything.
