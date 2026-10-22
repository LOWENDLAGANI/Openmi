# Openmi — repo agent

An agent that reads a GitHub repository and proposes changes. **It commits only
when you say so**, on a branch of its own.

> **Status: Phase 1 complete — read-only.** Connect GitHub from the sidebar,
> pick a repository, then ask about the code: the agent calls `list_files`,
> `read_file` and `search_code` and cites real paths and lines. It has no write
> tool at all, so there is nothing to approve yet. Proposal, diff review and
> commit are Phase 2 — see [docs/OVERHAUL_SPEC.md](docs/OVERHAUL_SPEC.md).

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
- **The read-only agent.** Native function calling, up to eight steps and 60k
  tokens per turn, one flat Code charge per turn. Each step's reads are shown in
  the message as they happen. Turn state is HMAC-signed, so a client cannot
  raise its own step budget or claim a turn was already paid.

## What is not here yet

- Diff review, approvals, commits. The model has no write tool; the only route
  that touches GitHub's write API will live behind the approval record.
- Any code execution, test run or preview. The agent cannot run what it writes,
  and the prompt tells it to say so rather than imply otherwise.

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
| `AGENT_TURN_SECRET` | Signs agent turn state; must be stable across instances. Falls back to `GITHUB_TOKEN_KEY`. |

### Connecting GitHub

1. In the Firebase console → Authentication → Sign-in method, **enable GitHub**.
   Firebase hosts the OAuth app, so this repository needs no client id or secret.
2. Set `GITHUB_TOKEN_KEY` (`openssl rand -hex 32`) and `AGENT_TURN_SECRET`.
3. Deploy the updated `database.rules.json`: the connection lives at
   `users/{uid}/github` and projects at `projects/{uid}/{id}`, both read and
   written only by their owner.
4. In the app, open the repository panel from the sidebar and connect. Then pick
   a repository — the panel pins the branch head as the project's base commit.

## Layout

```
app/                 routes; /api/chat is the streaming proxy, /api/agent/step
                     is one read-only agent step
components/          chat shell, sidebar, settings, admin console, RepoPanel
lib/                 dew.ts (pricing), providers.ts (server-only chains),
                     models.ts (client-visible catalog), db.ts (Dexie),
                     serverControl.ts (identity, bans, rate limits)
lib/github/          client.ts (REST, read-only), tree.ts (filtering),
                     search.ts (lexical), cache.ts, crypto.ts (seal/sign),
                     store.ts (the sealed connection)
lib/agent/           tools.ts (the three read tools), model.ts (one decision),
                     turns.ts (signed turn budget), run.ts (one step)
docs/OVERHAUL_SPEC.md  the contract for the repo agent
docs/legacy/         the previous Openmi product docs, kept for reference
```

## Non-negotiable rules

1. **Nothing is committed without an approval record.** The model has no write
   tool — `lib/github/client.ts` contains only GETs. The only route that will
   write to GitHub requires a record bound to the user, repository, base SHA and
   change-set hash.
2. **Property names never reach the browser.** `lib/providers.ts` and
   `lib/modelEngines.ts` are server-only; `lib/models.ts` is what the client sees.
3. **A balance is never read from the request.** Dew is read with the caller's
   verified token and enforced before any model call.
4. **Repository content is data, not instructions.** A README cannot change the
   agent's rules.
