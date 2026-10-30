# Openmi — repo agent

An agent that reads a GitHub repository and proposes changes. **It commits only
when you say so**, on a branch of its own.

> **Status: Phase 2 complete — the shippable MVP.** Connect GitHub from the
> sidebar, pick a repository, then ask about the code: the agent calls
> `list_files`, `read_file` and `search_code` and cites real paths and lines. It
> can also call `propose_edits`, which stages a change and returns a unified
> diff the server computed from the base commit. That change is saved for
> review; nothing reaches GitHub until you press **Approve & commit**, which
> opens a pull request from an `agent/` branch. Phase 3 (execution) is deferred —\n> see [docs/OVERHAUL_SPEC.md](docs/OVERHAUL_SPEC.md).

## What works today

- Chat with **Auto**, **Groq** and **DeepSeek V4.1 Flash** modes, streamed over
  SSE with provider fallback and continuation when a model hits its output
  limit.
- Local-first history in IndexedDB (Dexie), synced to the signed-in account.
- **An account is required.** Sign in or register with Google, GitHub, Microsoft
  or an email address and password, all held by Supabase Auth. Disposable email
  domains are refused at sign-up, so an address that expires cannot become the
  only key to somebody's chats.
- **Dew**: one price — `3` Dew buys a one-hour session that covers every answer
  in every chat on the model it was bought for. A session started in the
  repository workspace is bound to that repository too: asking for another model
  or another repository is refused until the hour is ended. Every account also
  gets **10 free Dew a day**, refilled at midnight in
  the account's own timezone (the browser's at registration, Malaysia until one
  is known) and spent before paid credit; unused free Dew does not carry over,
  while trial, redeemed and topped-up Dew never expires. A spend history on
  `/activity` shows where it went: per day, per model, and how much came from
  the  free bucket rather than paid credit. Invitations on `/plus` give both
  people 25 Dew, with one claim per account and a ten-invite cap per inviter.
  Token counts are still recorded and shown; they no longer price the request.
- **Paid passes**: RM 18 for 15 days or RM 35 for 30 days, activated by the
  owner after the existing manual DuitNow transfer. The card also prints an
  approximate figure in the currency of the browser's regional language — a
  courtesy for readers who do not think in ringgit, never the amount charged. A pass raises the daily bucket to **15 Dew** and adds
  priority support, more usage and everything in Free. The hour session is
  server-owned: one live session per account, charged atomically when it starts,
  bound to one model and one repository, and a second start for a different
  scope is refused with the active one named.
- Folders, a thirty-day trash, palette search, branching
  replies, web search, attachments, push, PWA, admin console.
- **A context ring** above the composer: the last request's real prompt count
  plus an estimate of the draft, against the per-request budget the server
  enforces, with a breakdown and a fresh-chat offer past 90%.
- **Rate limits you can see**: one policy table, one 429 shape carrying
  `Retry-After`, and a composer that counts the wait down instead of failing.
- **One small ad above the composer** (optional): AdSense, reserved height,
  hidden without both public ids, switchable off from the console. An Adsterra
  popunder can be enabled beside it with one tag URL. `/privacy` says what both
  collect.
- **A sidebar that is part of the account.** Folders, the folder a chat is filed
  under, and the trash are read and written through the same session as the
  chats. A folder or a chat deleted here is soft-deleted in the database, so a
  device that was offline cannot upload it back; a restore or a permanent delete
  in the trash records the decision before it is delivered, so a decision made
  offline is not undone by the next sign-in.
- **GitHub connected with a personal access token.** A token pasted into the
  panel is checked against `GET /user` and one repository listing, then sealed
  with AES-256-GCM under the account's stored connections. An account can hold
  several connections and mark one as the default; reconnecting the same GitHub
  account rotates its token rather than adding a second entry. No response ever
  contains a token. A GitHub OAuth App is still available as a second door when
  one is configured.
- **A repository workspace.** Repo picker over every repository the connection
  can read, a filtered file tree, and a read-only file viewer, all pinned to one
  commit (the project records `baseSha` when it is attached).
- **The repository agent.** Native function calling, up to eight steps and 60k
  tokens per turn, one flat Code charge per turn. A step is streamed rather than
  answered once: each read is announced in the message before it runs and marked
  done when it returns, and the model's prose arrives as it is written, so a
  turn that takes half a minute never looks frozen. Turn state is HMAC-signed,
  so a client cannot raise its own step budget or claim a turn was already paid.
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
- **A shared answer.** A finished answer can be published as a read-only link:
  a copy of the question and the answer, no account or chat attached, expiring
  after thirty days and revocable from Settings → Your data. The public view has
  no owner column, and a revoked link stops answering on the next read.

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

The **About** page carries a setup banner: it lists exactly the keys this
deployment is missing, what each one stops working, and where the value comes
from. It also audits the database and names any migration that has not been
applied, instead of leaving a `PGRST202` to decipher. A key that has been set or
a migration that has been applied drops out of the list on the next read, and
when nothing is missing the banner is a single line saying so. It reports
presence only — `GET /api/setup` never returns a key value or a database row — so
it is safe on a public page.

| Script | What it does |
|---|---|
| `bun run dev` | Next.js dev server on `0.0.0.0`. |
| `bun run build` | Production build. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run lint` | ESLint. |
| `bun run test` | The unit and source-contract suites. |

## Configuration

Copy `.env.example` to `.env.local`.

### The backend is Supabase

Accounts, cloud history, the admin console, GitHub connections, projects and the
Dew ledger all live in one Postgres database in a Supabase project. Firebase is
gone: no dependency, no `database.rules.json`, no Admin SDK.

Access is decided in the database, not in a route. The browser talks to PostgREST
with the caller's own JWT, and every table carries row-level security that keys
off `auth.uid()`. The server routes do the same thing with a client built from
the caller's bearer token. The deployment's one service-role key is confined to
`lib/supabaseAdmin.ts` and used only by the `/api/agent/runs` routes — creating
and advancing a run is the one job with no caller to carry a token for.
`supabase/migrations/` is the whole authority
surface, and `supabase/README.md` is the one-time dashboard setup.

If you ran into the sign-in error that sends people down a rabbit hole, here is
the honest inventory of what actually causes it:

| Backend answer | What it actually means |
|---|---|
| `provider_disabled` | The provider you tapped is switched off for this project. Authentication → Sign In / Providers → turn on Google, GitHub, Azure (Microsoft) or Email. |
| `email_provider_disabled` | **Email** is switched off, so register and sign in have no provider. Authentication → Sign In / Providers → Email. |
| `invalid_api_key` / `Invalid API key` | the build is holding a value the project does not accept — the wrong project, or variables set after the last build. |
| `relation "…" does not exist` | the migrations in `supabase/migrations/` were never pushed to this project. Run `supabase db push`. |
| rows read as empty for a signed-in user | RLS is doing its job and the caller's row is not theirs — or the migration that created the policy did not run. |

The `invalid_api_key` row is the one people keep missing: `NEXT_PUBLIC_*` values
are inlined into the JS at build time. Adding them after a build does not reach
the already-built site — set the values, then build the site.

### Environment variables

Nothing in it is required to boot: with no model key the app shows a setup notice
instead of crashing.

The important ones for **this build**:

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Auto mode routing. |
| `GEMINI_API_KEY` | Auto fallback (V3 → V2 → V1). |
| `GROQ_API_KEY` | Groq — the Code mode model, and Auto's last-resort fallback. |
| `DEEPSEEK_API_KEY` | DeepSeek — the DeepSeek V4.1 Flash mode, and nothing else. |
| `NEXT_PUBLIC_ADSENSE_CLIENT_ID` | Public AdSense publisher id (`ca-pub-…`). Absent means no banner and no gap. |
| `NEXT_PUBLIC_ADSENSE_SLOT_ID` | Public ad-unit slot id. Both ids are required for the unit to render. |
| `TAVILY_API_KEY` | Web search and source links. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (Project Settings → API). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The anon public key. Public by design: it identifies the project, and RLS protects the rows. Both the browser and the server routes use it, always with the caller's own JWT. |
| `OPENMI_ADMIN_EMAIL` | The one address allowed into the console. Access is a database grant — see `supabase/README.md`. |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for share previews, the sitemap, `robots.txt` and the GitHub OAuth callback. `https://openmi.space` in production; the code falls back to that domain when it is unset. |
| `GITHUB_TOKEN_KEY` | 32-byte hex key that seals stored GitHub tokens and accounts' own model keys. Unset means GitHub cannot be connected and API keys cannot be stored. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional GitHub OAuth App, a second door beside the pasted token. |
| `AGENT_TURN_SECRET` | Signs agent turn state; must be stable across instances. Falls back to `GITHUB_TOKEN_KEY`. |
| `AGENT_SWEEP_SECRET` | The shared secret the run watchdog presents to `/api/agent/runs/sweep`. Unset means the sweep is off. |

One privileged key exists, and one thing may use it. `SUPABASE_SERVICE_ROLE_KEY`
is read by `lib/supabaseAdmin.ts` for the `/api/agent/runs` routes, which create
and advance a repository turn after the tab is closed and therefore have no
caller to carry a token for. They take the owner from the verified session, never
from the request body. Every other route carries the caller's token, exactly as
the browser does, and may not import that module. Without the key the agent still
works; it just stops when the tab does.

### Bringing your own model keys

**Settings → API keys** lets an account store its own OpenRouter, Google Gemini
or Groq key instead of relying on the deployment's. Saving is checked with the
vendor first — one list call, never a model call — so a key that does not work
is not stored as if it did. The key is then sealed with AES-256-GCM under
`GITHUB_TOKEN_KEY` and read back only on the server, with the account's own
token; the browser is shown `••••` and the last four characters, never the key.
Requests from that account (Auto and Code chat, and the repository agent) prefer
it over the deployment's key, which stays as the fallback when the personal key
is removed or revoked.

The table comes from `supabase/migrations/20261026000000_provider_keys.sql`.
Without that migration, saving answers 503 and names the migration. The feature
is optional: with no personal key, everything runs on the deployment's keys as
before.


## Signing in

Openmi requires an account. There is no guest mode and no anonymous identity:
the sign-in screen is the whole interface until one of these doors returns a
session.

- **Google**, **GitHub**, **Microsoft** (Supabase's `azure` provider) — full-page
  OAuth round trips handled by Supabase Auth.
- **Email and password** — registering creates a real Supabase user; the password
  is hashed and held by Supabase, never by this app.

The same provider buttons register a first-time account, because Supabase creates
the user when the provider returns one it has not seen. A confirmation mail goes
out on email registration when the project has confirmation on, and can be
resent from the form; nothing is blocked while it is unconfirmed. Password reset
uses Supabase's recovery mail, which returns to `/auth/reset-password` and asks
for a new password immediately; a signed-in email account can also change its
password later from Settings.

All four methods are dashboard switches (Authentication → Sign In / Providers),
not build settings. `supabase/README.md` has the click-by-click version,
including the callback URLs each provider needs.

### One account, several sign-in methods

**Settings → Account → Sign-in methods** attaches another provider to the account
that is already signed in, so someone who began with Google and later uses
GitHub ends up with one account and one set of chats instead of two. Each method
can be unlinked again, except the last one — Supabase refuses to leave an account
with no way in, and the screen does not offer it. Attaching is a Supabase
identity link (`linkIdentity`), so the new provider resolves to the same
`auth.users` row from any browser.

One project switch is required, because identity linking is opt-in:
**Authentication → Sign In / Providers → Manual linking** must be on. Without it,
attaching fails with `manual_linking_disabled` and the screen says which toggle
to flip. Supabase also links a *verified* email that already has an account when
that person signs in with a new provider, which is why the plain sign-in flow
already avoids most duplicates; the Settings screen is for attaching a method
beforehand, seeing what is attached, and unlinking one.

Two accounts that already exist are not merged automatically, and this app does
not merge them: the duplicate provider is reported with the account it belongs
to, and the way out is to sign in with that provider and unlink it there, then
attach it to the account you want to keep.

### What follows the account

Chats, messages, memories, GitHub connections, projects, change sets, Dew, push
subscriptions and **preferences** are all owned by `auth.uid()` and protected by
row-level security. Preferences — appearance, response length, reasoning effort,
search mode, the last model, whether the tour has been seen, and the display name
— live in `user_preferences` and are written as they change. localStorage is
still the first read, so the interface paints instantly and works offline; the
account's copy is adopted right after the session is known, which is what makes
a second browser open with the same settings.

**The copy on a browser belongs to one account.** IndexedDB is per browser, not
per account, so signing in as somebody else on the same machine hands the device
over: the previous account's chats, messages, folders, trash and pending trash
decisions are cleared *before* this account's history is pulled, and the cloud
push refuses to upload local rows until the handover has run. The same account
signing back in on the same browser keeps its cache and pulls only what is new.

## Connecting GitHub

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

4. Push the schema: `supabase db push` (or paste `supabase/migrations/*.sql` in
   order into the SQL editor). Connections live in `github_connections`, with
   `github_default` pointing at the chosen one, and projects in `projects` — all
   owner-only by RLS, and every write goes through a policy that checks
   `auth.uid()`.
5. Pick a repository in the panel — it pins the branch head as the project's
   base commit.

If no key is configured, the panel says which value is missing instead of
leaving a button that cannot work; if the status check fails or times out, it
shows the failure with a retry rather than staying on "Checking the
connection…".

## Layout

```
app/                 routes; page.tsx is the public landing page, chat/ is the
                     product behind the account gate, /api/chat is the streaming
                     proxy and /api/agent/step one read-only agent step
components/          chat shell, sidebar, settings, admin console, RepoPanel
lib/                 dew.ts (pricing), providers.ts (server-only chains),
                     models.ts (client-visible catalog), db.ts (Dexie),
                     supabase.ts (the client and the per-request clients),
                     serverControl.ts (identity, bans, rate limits),
                     account.ts, emailAuth.ts (OAuth, register, sign in,
                     verify, reset), preferences.ts (account-synced settings),
                     cloudHistory.ts (chats), cloudAdmin.ts (console),
                     serverDew.ts, serverRedeem.ts (the ledgers)
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
components/AuthScreen.tsx  the required sign-in/register screen
components/EmailAuthForm.tsx  email register, sign in, resend, reset
docs/OVERHAUL_SPEC.md  the contract for the repo agent
docs/legacy/         the previous Openmi product docs, kept for reference
docs/MIGRATE_TO_SUPABASE.md  the record of the Firebase → Supabase migration
supabase/migrations/ Postgres schema, functions and row-level security — the
                     whole authority surface, replacing Firebase Auth, the
                     Realtime Database and database.rules.json
supabase/seed.sql    the settings row and an optional admin grant
supabase/README.md   one-time dashboard setup, and how to grant an admin
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

## The pre-flight review

Nothing reaches the review screen unchecked. Two passes run before a proposal is
handed over, and the card names the ones that actually ran:

- **Static checks**, over the exact bytes that would be written: a file that
  would end up empty, merge-conflict markers, JSON that does not parse,
  unbalanced brackets in a script, and relative or `@/` imports that point at a
  path the tree does not have.
- **One model read** of the diff, given those findings, answering `pass` or
  `fix` as JSON. It is advisory and it is told it cannot run anything, so it
  never claims a test passed.
- **One repair round.** An `error` from either pass sends the agent back with
  the findings; the checks then run again on what would really be committed, and
  the card says `repaired once`.

This is **not a build**. Nothing is cloned, installed, typechecked or tested —
there is no sandbox in this deployment — and the card says so instead of
implying a green build. Folding a real container run into the same gate is the
next step, not something this does quietly.

Connecting GitHub returns to `/chat` (where the repository panel reads
`?github=connected` and opens itself), not to the landing page.

