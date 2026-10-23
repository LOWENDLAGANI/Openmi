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
- **An account with an email address and a password**, held by Firebase Auth.
  Registering upgrades the guest identity this browser already has, so the UID —
  and every chat written under it — stays exactly where it is. A confirmation
  mail is sent on registration; nothing is gated on it.
- **Dew**: one flat price per request, per model — `0.25` for Auto, `0.5` for
  Code. Token counts are still recorded and shown; they no longer price the
  request.
- Temporary chats, folders, trash with a thirty-day restore, palette search,
  branching replies, web search, attachments, push, PWA, admin console.
- **GitHub connected with a personal access token.** A token pasted into the
  panel is checked against `GET /user` and one repository listing, then sealed
  with AES-256-GCM under `users/{uid}/githubConnections`. An account can hold
  several connections and mark one as the default; reconnecting the same GitHub
  account rotates its token rather than adding a second entry. No response ever
  contains a token. A GitHub OAuth App is still available as a second door when
  one is configured, and the Firebase-hosted credential still works for
  deployments that already have it.
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
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional GitHub OAuth App, a second door beside the pasted token. |
| `AGENT_TURN_SECRET` | Signs agent turn state; must be stable across instances. Falls back to `GITHUB_TOKEN_KEY`. |

### Signing in

Signing in is an email address and a password, and the password is Firebase
Auth's to hold — this app never sees or stores it. Turn the provider on under
Firebase console → Authentication → Sign-in method → **Email/Password**. That is
the only setup; the `NEXT_PUBLIC_FIREBASE_*` values already in reach are all the
client needs.

Registering **links a credential onto the anonymous account this browser already
has** rather than creating a new user, so the UID does not change and the chats
written before registering stay where they are. If the address already belongs
to an account, the link is refused and the app signs into that account instead —
the existing history is the real one. A confirmation mail goes out on
registration and can be resent from the account row; nothing is blocked while it
is unconfirmed.

### Connecting GitHub

**A. Personal access token (the door that needs no console change)**

1. Set `GITHUB_TOKEN_KEY` to a 32-byte hex value (`openssl rand -hex 32`) and
   redeploy. Nothing else is required.
2. In the app, open the repository panel and paste a token from
   github.com/settings/tokens with the **`repo`** scope (or Contents: read plus
   Metadata: read on a fine-grained token).
3. The server asks GitHub who the token belongs to and whether it can list a
   repository. A token that is alive but cannot read repositories is **stored
   with a warning**, because adding the scope is a thing the person can go and
   do; a token GitHub refuses is rejected with the reason.

An account may hold several tokens — a personal one, a work one, a fine-grained
one — and the list lets one be made the default. Reconnecting the same GitHub
account replaces its entry instead of adding another.

**B. GitHub OAuth App (optional)**

A full-page round trip instead of a pasted token. Create the app at GitHub →
Settings → Developer settings → **OAuth Apps** → New OAuth App, with the
**Authorization callback URL** set to
`https://<your-domain>/api/github/oauth/callback` for every origin you use, then
set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `NEXT_PUBLIC_SITE_URL` to the
exact public origin. The token is sealed into an httpOnly cookie bound to your
account.

**Then, either way:**

4. Deploy the updated `database.rules.json`. Connections live at
   `users/{uid}/githubConnections/{id}` with a `users/{uid}/githubDefault`
   pointer, and projects at `projects/{uid}/{id}` — all owner-only.
5. Pick a repository in the panel — it pins the branch head as the project's
   base commit.

If no key is configured, the panel says which value is missing instead of
leaving a button that cannot work; if the status check fails or times out, it
shows the failure with a retry rather than staying on "Checking the
connection…".

## Layout

```
app/                 routes; /api/chat is the streaming proxy, /api/agent/step
                     is one read-only agent step
components/          chat shell, sidebar, settings, admin console, RepoPanel
lib/                 dew.ts (pricing), providers.ts (server-only chains),
                     models.ts (client-visible catalog), db.ts (Dexie),
                     serverControl.ts (identity, bans, rate limits),
                     emailAuth.ts (register, sign in, verify, reset)
lib/github/          client.ts (REST, read-only), pat.ts (token scopes and ids),
                     connections.ts (the token collection and its default),
                     oauth.ts (GitHub OAuth App flow), tree.ts (filtering),
                     search.ts (lexical), cache.ts, crypto.ts (seal/sign),
                     store.ts (which connection a request may use)
lib/agent/           tools.ts (the four tools), edits.ts (staging and unified
                     diffs), model.ts (one decision), turns.ts (signed turn
                     budget), run.ts (one step)
lib/changesets.ts    change-set ids, hashes, branch naming, signed change sets
                     and approvals, the commit gate, the stored records
components/ChangeReview.tsx  the diff cards and Approve & commit
components/EmailAuthForm.tsx  register, sign in, resend, reset
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
