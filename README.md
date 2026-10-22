# Openmi — repo agent

An agent that reads a GitHub repository and proposes changes. **It commits only
when you say so**, on a branch of its own.

> **Status: Phase 2 complete — the shippable MVP.** Connect GitHub from the
> sidebar, pick a repository, then ask about the code: the agent calls
> `list_files`, `read_file` and `search_code` and cites real paths and lines. It
> can also call `propose_edits`, which stages a change and returns a unified
> diff the server computed from the base commit. That change is saved for
> review; nothing reaches GitHub until you press **Approve & commit**, which
> opens a pull request from an `agent/` branch. Phase 3 (execution) is deferred —
> see [docs/OVERHAUL_SPEC.md](docs/OVERHAUL_SPEC.md).

## What works today

- Chat with **Auto** and **Code** modes, streamed over SSE with provider
  fallback and continuation when a model hits its output limit.
- Local-first history in IndexedDB (Dexie), synced to Firebase when configured.
- A guest identity that can be linked to a Google account without moving history.
- **Dew**: one flat price per request, per model — `0.25` for Auto, `0.5` for
  Code. Token counts are still recorded and shown; they no longer price the
  request.
- Temporary chats, folders, trash with a thirty-day restore, palette search,
  branching replies, web search, attachments, push, PWA, admin console.
- **GitHub connected to the existing account.** `GithubAuthProvider` links a
  credential to the Firebase user, so the UID, history and Dew wallet stay put.
  The access token is sealed with AES-256-GCM and stored at
  `users/{uid}/github`; no response ever contains it.
- **A repository workspace.** Repo picker over every repository the connection
  can read, a filtered file tree, and a read-only file viewer, all pinned to one
  commit (the project records `baseSha` when it is attached).
- **The repository agent.** Native function calling, up to eight steps and 60k
  tokens per turn, one flat Code charge per turn. Each step's reads are shown in
  the message as they happen. Turn state is HMAC-signed, so a client cannot
  raise its own step budget or claim a turn was already paid.
- **Proposals with derived diffs.** `propose_edits` stages a whole-file rewrite
  or a unique `old_string`/`new_string` replacement, up to six files per call.
  The diff is computed on the server from the file at the base commit — the
  model never supplies one — and the tool has no token, no client and no fetch,
  so a proposal cannot reach GitHub. A replacement that matches zero or several
  places is refused rather than guessed at.
- **Review, approval and one commit.** A proposal is stored as a signed change
  set and rendered under the answer as diff cards with per-file collapse and
  add/remove counts. **Approve & commit** writes a signed approval, then the one
  endpoint in the product that writes to GitHub: blobs → tree based on the base
  commit → commit → `agent/<repo>-<id>` branch → pull request. A moved default
  branch is refused with a re-diff, a double submit returns the first commit,
  and another account's change set cannot be read or committed.

## What is not here yet

- Any code execution, test run or preview. The agent cannot run what it writes,
  and the prompt tells it to say so rather than imply otherwise. That is Phase 3,
  deferred on purpose.
- Committing to the default branch. The branch policy is a setting in the spec
  and, for now, an unconditional refusal in code.

## Getting started

```bash
bun install
bun run dev
```

Open http://localhost:3000.

| Script | What it does |
|---|---|
| `bun run dev` | Next.js dev server on `0.0.0.0`. |
| `bun run build` | Production build. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run lint` | ESLint. |
| `bun run test` | The unit and source-contract suites. |

## Configuration

Copy `.env.example` to `.env.local`. Nothing in it is required to boot: with no
model key the app shows a setup notice instead of crashing.

The important ones:

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Auto mode routing. |
| `GEMINI_API_KEY` | Code mode (V3 → V2 → V1 only). |
| `GROQ_API_KEY` | Last-resort fallback for Auto. |
| `TAVILY_API_KEY` | Web search and source links. |
| `NEXT_PUBLIC_FIREBASE_*` | Accounts, cloud history, admin console, Dew ledger. |
| `OPENMI_ADMIN_EMAIL` | The one address allowed into the console. |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for share previews and the sitemap. |
| `GITHUB_TOKEN_KEY` | 32-byte hex key that seals stored GitHub tokens. Unset means GitHub cannot be connected. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | A GitHub OAuth App, so visitors can connect GitHub without a Firebase console change. |
| `AGENT_TURN_SECRET` | Signs agent turn state; must be stable across instances. Falls back to `GITHUB_TOKEN_KEY`. |

### Connecting GitHub

There are two doors, and the panel picks whichever this deployment has. The
GitHub OAuth App is preferred because it needs nothing done in the Firebase
console.

**A. GitHub OAuth App (recommended)**

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.
   Set the homepage to your site, and the **Authorization callback URL** to
   `https://<your-domain>/api/github/oauth/callback` for every origin you use
   (add a second app, or edit the callback, for local development).
2. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_TOKEN_KEY`
   (`openssl rand -hex 32`), `AGENT_TURN_SECRET`, and `NEXT_PUBLIC_SITE_URL` to
   the exact public origin — the callback URL is derived from it and must match
   the OAuth App character for character.
3. In the app, open the repository panel from the sidebar, press **Connect
   GitHub**, approve the app, and you are returned to the panel. The access
   token is sealed and kept in an httpOnly cookie bound to your account; no
   response contains it.

**B. Firebase-hosted GitHub credential (existing deployments)**

1. In the Firebase console → Authentication → Sign-in method, **enable GitHub**.
   Firebase hosts the OAuth app, so this repository needs no client id or secret.
2. Set `GITHUB_TOKEN_KEY` and `AGENT_TURN_SECRET`.
3. The connection is sealed and written to `users/{uid}/github` using your own
   Firebase token.

**Then, either way:**

4. Deploy the updated `database.rules.json`: projects live at
   `projects/{uid}/{id}`, readable and writable only by their owner. A
   connection stored in the database is owner-only for the same reason.
5. Pick a repository in the panel — it pins the branch head as the project's
   base commit.

If neither door is configured, the panel says which values are missing instead
of leaving a button that cannot work; if the status check fails or times out, it
shows the failure with a retry rather than staying on "Checking the
connection…".

## Layout

```
app/                 routes; /api/chat is the streaming proxy, /api/agent/step
                     is one read-only agent step
components/          chat shell, sidebar, settings, admin console, RepoPanel
lib/                 dew.ts (pricing), providers.ts (server-only chains),
                     models.ts (client-visible catalog), db.ts (Dexie),
                     serverControl.ts (identity, bans, rate limits)
lib/github/          client.ts (REST, read-only), oauth.ts (GitHub OAuth App
                     flow), tree.ts (filtering), search.ts (lexical), cache.ts,
                     crypto.ts (seal/sign), store.ts (the sealed connection)
lib/agent/           tools.ts (the four tools), edits.ts (staging and unified
                     diffs), model.ts (one decision), turns.ts (signed turn
                     budget), run.ts (one step)
lib/changesets.ts    change-set ids, hashes, branch naming, signed change sets
                     and approvals, the commit gate, the stored records
components/ChangeReview.tsx  the diff cards and Approve & commit
docs/OVERHAUL_SPEC.md  the contract for the repo agent
docs/legacy/         the previous Openmi product docs, kept for reference
```

## Non-negotiable rules

1. **Nothing is committed without an approval record.** The model has no write
   tool — `lib/github/client.ts` contains only GETs, and every write lives in
   `lib/github/commit.ts`. The only route that writes to GitHub requires an
   HMAC approval bound to the user, repository, base SHA and change-set hash,
   refuses a branch that has moved, and only ever creates an `agent/` branch.
2. **Property names never reach the browser.** `lib/providers.ts` and
   `lib/modelEngines.ts` are server-only; `lib/models.ts` is what the client sees.
3. **A balance is never read from the request.** Dew is read with the caller's
   verified token and enforced before any model call.
4. **Repository content is data, not instructions.** A README cannot change the
   agent's rules.
