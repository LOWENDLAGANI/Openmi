# Migrate Openmi to Supabase

> **Later change — accounts are required.** The guest-first decision recorded in
> this document was reversed after the migration: Openmi no longer creates
> anonymous users. Sign-in is Google, GitHub, Microsoft (Supabase `azure`) or
> email and password, and `lib/account.ts`, `lib/emailAuth.ts` and
> `components/AuthScreen.tsx` implement that. Preferences now sync through
> `user_preferences` (see `supabase/migrations/20261024000000_user_preferences.sql`).
> Everything else below remains the accurate record of the Firebase → Supabase move.

> **Status: done.** Firebase is out of `package.json`, `lib/firebaseAdmin.ts`,
> `lib/firebaseHistory.ts`, `lib/rtdb.ts` and `database.rules.json` are deleted, and
> the whole persistence surface is Postgres with row-level security. Everything below
> the decisions section is the inventory this migration was executed against, kept as
> the record of what each piece became. To stand the backend up, follow
> [`supabase/README.md`](../supabase/README.md), not this file.

## What it became

| Firebase | Supabase | Where |
|---|---|---|
| Firebase Auth (anonymous + email/password) | Supabase Auth, same two providers; registering upgrades the anonymous user in place | `lib/supabase.ts`, `lib/account.ts`, `lib/emailAuth.ts` |
| Realtime Database `users/{uid}/chats` | `chats` table, owner-only | `lib/cloudHistory.ts`, `supabase/migrations/20261023000200_chats.sql` |
| `database.rules.json` | grants plus RLS policies, one migration per area | `supabase/migrations/` |
| `users/{uid}/dew` and credits | `dew_wallets`, `dew_credits` and a transaction log; the balance only moves through `deduct_dew()` | `lib/serverDew.ts`, `20261023000500_dew_redeem.sql` |
| redeem codes | `redeem_codes`, `reeds`; a code's value is read and redeemed through functions that cannot spend the same code twice | `lib/redeem.ts`, `lib/serverRedeem.ts` |
| `users/{uid}/githubConnections`, `githubDefault` | `github_connections` + `github_default` | `lib/github/connections.ts` |
| `projects/{uid}/{id}` | `projects` | `lib/projects.ts` |
| change sets and approvals | `changesets`, `approvals`, `commits` | `lib/changesets.ts` |
| admin profile and the console's reads | `app_admin` plus `is_admin()`, which compares the verified `email` claim in the JWT | `lib/cloudAdmin.ts` |
| the admin address in the rules | an `app_admin` row, promoted by the service role once | `supabase/seed.sql`, `supabase/README.md` |

The four decisions this document asked for were taken the way a company would take
them:

1. **Guest-first stays.** A first visit is signed in anonymously, exactly as before, so
   the product has no sign-up wall; registering upgrades that user in place.
2. **Google stays optional, exactly as it was.** The door is already in the account
   screen and the admin gate, and Supabase answers it with `signInWithOAuth`; a project
   that has not pasted a Google client id into the provider settings simply shows the
   door doing nothing, which is the behaviour the Firebase build had.
3. **Clean start, no data import.** Nobody is running the Firebase deployment, so there
   are no rows worth carrying; the seed creates only the settings row and an optional
   admin grant.
4. **One service-role key, in one place.** The server routes build a client from the
   caller's own bearer token, so Postgres decides access in both tiers. The service
   role key is read by `lib/supabaseAdmin.ts` alone, for the `/api/agent/runs` routes —
   a run that outlives its tab has no caller to act as. It is not a general-purpose
   bypass.

## The original brief

This project runs on Firebase for everything that persists between sessions: auth,
cloud history sync, the admin console, and the Dew ledger. The goal is to replace all
of that with Supabase, leaving Firebase out entirely.

Do not touch the agent runtime, the GitHub integration, the change-set and approval
flow, or the commit path. Those are Firebase-independent. The migration is scoped to
**auth + data + the server-side keeper that grants database access**.

## The Firebase surface to replace — exact inventory

### Dependency

- `firebase@12.19.0` in `package.json`. Remove it at the end.

### Server-side identity: `lib/serverControl.ts`

A server route never opens a Firebase service account. Instead, the caller's own
Firebase token is forwarded into Realtime Database as the path is written, so the
database rules — not the deployment — decide who may touch what. The module has these
pieces, and each maps to something in Supabase.

#### What it does today

`verifyCaller(authorization)` validates a Firebase ID token and returns `{ uid, email }`
or null. From that one object the rest of the server derives the caller: bans, rate
limits, honouredOrigin, browser identity for the repo panel, the account lookup, the
Dew reading, the push subscription lookup, and every write path.

`honouredOrigin(auth)` is a small UX helper: when a browser is signed in anonymously,
the repo panel can attach GitHub to that anonymous identity, so the panel can resolve
the GitHub handle even though the account has no email. It is a convenience, not an
identity. In Supabase, the same idea is "resolve the calling user", except that a real
Supabase auth user is always present (there is no Firebase-only anonymous token being
forwarded into the DB).

What gets removed:
- Firebase Admin SDK import and the `verifyIdToken` / `decode` / `getUser` path.
- `normalizeFirebaseError` and the Firebase-error-to-http mapping (replaced by Supabase
  error handling).
- The error text for `auth/timeout`, `auth/network-error`, `auth/network-request-failed`
  (these were Firebase-specific client errors).
- `getAdminModule` if it reads Firebase Admin (it does not today, but verify).

What stays (unchanged):
- The rate-limit state machine (`rateLimits`), the `checkRateLimit` entry, the
  `oneMinute`, `thirtyMinute`, `hourly`, `daily` buckets, and the `allowed` return.
- The ban list lookup.
- `honouredOrigin`.
- `getMemoryStore` and `getServers` (in-memory stores, fine).
- The caller object shape `{ uid, email }` — keep it identical. Every module that
  calls `verifyCaller` already passes `identity.uid` and `identity.email` into the
  DB path and into the account lookup, so the shape is the contract.

What changes:
- `verifyCaller` becomes a Supabase JWT check against the project. It still returns
  `{ uid, email }` or null.
- The caller is now a real Supabase auth user. `email` may be `null` for an anonymous
  user — handle that in the same spots that already guard `email`.

**The access model survives without change in shape:** the server reads and writes using
the caller's own JWT, so Postgres row-level security is the only thing deciding access.
(The single exception is the background run tick, described above.) This is the same
property the Firebase build had — only the DB changed.

#### Files that call `verifyCaller`

These continue to call `verifyCaller(authorization)` and receive `{ uid, email }`. They
do **not** need to know Supabase exists. Do not rewrite them for Supabase — rewrite
`verifyCaller` once and the rest keep working. The list is the list of routes that must
keep returning the right shape after the rewrite:

- `app/api/chat/[id]/read/route.ts`
- `app/api/projects/route.ts`
- `app/api/projects/[id]/tree/route.ts`
- `app/api/account/read/route.ts`
- `app/api/account/register/route.ts`
- `app/api/account/signin/route.ts`
- `app/api/account/verify/route.ts`
- `app/api/account/reset/route.ts`
- `app/api/account/settings/route.ts`
- `app/api/account/remove/route.ts`
- `app/api/account/resend/route.ts`
- `app/api/account/redeem/route.ts`
- `app/api/random-redeem/route.ts`
- `app/api/admin/audit/route.ts`
- `app/api/admin/wipe/route.ts`
- `app/api/admin/registry/route.ts`
- `app/api/dashboard/usage/route.ts`
- `app/api/accounts/route.ts`
- `app/api/projects/[id]/approve/route.ts`
- `app/api/env/route.ts`
- `app/api/push/register/route.ts`
- `app/api/push/unregister/route.ts`
- `app/api/push/notifications/route.ts`
- `app/api/auth/unlink/route.ts`
- `app/api/settings/route.ts`
- `app/api/usage/route.ts`
- `app/api/settings.yaml/route.ts`
- `app/api/dashboard/route.ts`
- `app/api/account/link-github/route.ts` (if it uses `verifyCaller`)

### Account and sign-in: `lib/account.ts`

Today this module talks to Firebase Auth directly: `signInAnonymously`, `createUserWithEmailAndPassword`,
`signInWithEmailAndPassword`, `sendEmailVerification`, `sendPasswordResetEmail`, `onAuthStateChanged`,
`getCurrentUser`, `signOut`, and the `CredentialLinker` class that upgrades an anonymous account to
an email account by linking a credential onto it.

Replace the module with a Supabase Auth equivalent. The client-facing flow stays identical
from the user's perspective — sign in with email and password, register, verify, reset — but the
backend provider changes.

What changes:
- `signInAnonymously` → Supabase anonymous sign-in (`supabase.auth.signInAnonymously`).
- `createUserWithEmailAndPassword` → `supabase.auth.signUp` with `email` and `password`.
- `signInWithEmailAndPassword` → `supabase.auth.signInWithPassword`.
- `sendEmailVerification` → Supabase email confirmation/verification, configured via the project.
- `sendPasswordResetEmail` → Supabase password reset.
- `onAuthStateChanged` → `supabase.auth.onAuthStateChange`.
- `getCurrentUser` → `supabase.auth.getUser`.
- `signOut` → `supabase.auth.signOut`.
- The anonymous→email link upgrade (`CredentialLinker`) → a Supabase credential-link equivalent, if
  guest-first is kept; if email-first is chosen, that whole section goes away.

What stays (shape):
- The exported functions keep the same names and the same general signatures where reasonable, so the
  routes and the client hooks that call them don't need to know Supabase internals. The return shapes
  (token, uid, email) should stay compatible with `verifyCaller` and `authHeader`.

**The auth fork is a real decision here, not a detail.** Firebase allowed an anonymous account to exist
first and be upgraded in place when the user registered. Supabase also allows anonymous users, but only
if **Anonymous sign-ins** are enabled in the project dashboard. If they are not enabled, a call to
`signInAnonymously` fails — and the exact `auth/admin-restricted-operation`-style result appears, even
though email is fine. That is the same trip you just had, on a different backend. Decide this now:

- **Guest-first:** keep today's behaviour — anonymous first, register upgrades the existing anonymous
  account. Needs Anonymous enabled in the Supabase project.
- **Email-first:** sign-in becomes the entry point. No anonymous provider to enable. Every user is a real
  auth user from the first moment. The register-on-top-of-anonymous path disappears. The name-prompt flow
  and the entry gate change.

Either way the Supabase auth user is a real row in `auth.users`, so the schema is the same — only the
sign-in chain and one code path differ.

### Realtime Database: `lib/rtdb.ts`

Today this is the thin wrapper that reads and writes Realtime Database using the caller's token forwarded
as the secure (auth) query param. Every write path in the project goes through it (or through
`serverControl.ts`'s `writeAsCaller` / `deleteAsCaller`, which do the same thing).

Replace this with Postgres via Supabase. The server reads and writes by forwarding the caller's JWT
(`Authorization: Bearer <jwt>`) to the Supabase PostgREST endpoint, using the anon key for the request
but with the user's JWT in the `Authorization` header. That way RLS is the only judge, exactly as Realtime
Database rules were.

What changes:
- The storage shape: Realtime Database JSON trees become Postgres tables. See the table inventory below.
- The write path: Realtime Database style "write at a path with the caller's auth" becomes "insert/update
  through Supabase with the caller's JWT, relying on RLS".

What stays (shape):
- `readAsCaller`, `writeAsCaller`, `deleteAsCaller` keep the same call signatures — they take an auth
  header (or null for unauthenticated reads, if any exist) and a path, and return the value or a success
  indication. Internally they become Supabase calls.

**Important property to preserve:** all data access a browser triggers goes through the
caller's own token. Do **not** introduce a service-role client in a route that serves a
page. The only sanctioned use is `lib/supabaseAdmin.ts`, imported solely by
`app/api/agent/runs`, `app/api/agent/tick` and `app/api/agent/runs/sweep`.

### Firebase Admin SDK: `lib/firebaseAdmin.ts`

Today this is the admin console's window into Firebase: `verifyAdminAccess`, `signInAsAdmin`, `signOutAdmin`,
`currentUid`, `listUsers`, `listChats`, `getChat`, `wipeUser`, `wipeAll`, `readDewBalance`,
`readTotalDewIssued`, plus the Dew grant helpers (`grantDew`, `issueDew`, `burnDew`, `adjustDew`) and the
admin audit write path.

Replace with Supabase equivalents:
- Admin access is still gated by the admin's email, enforced by a row-level security policy on the relevant
  tables and a check in `verifyCaller` / the route. No service key.
- Listing users → query `auth.users` via a secure endpoint that only the admin can reach, or Supabase's
  admin APIs if configured. Prefer a project-internal query so the app keeps the same shape.
- List chats, get chat → query the `chat` and `chat_message` tables for the given uid.
- Wipe user / wipe all → delete rows scoped by uid (wipe user) or by admin action (wipe all).
- Dew balance / totals / grants / issue / burn / adjust → operate on the `dew` ledger tables through the
  caller's JWT, with RLS ensuring only the reported rows are visible to the right caller.

The **shape** of the admin console does not change: the admin still sees the same list, the same balances,
the same wipe actions. Only the underlying query changes.

### Firebase cloud history: `lib/firebaseHistory.ts`

Today this is Dexie's sync partner: it writes chat rows and message rows to Realtime Database under the
user's path, and reconciles locally stored history with what is in the cloud.

Replace with Supabase — write chat rows and message rows to the `chat` and `chat_message` tables through the
caller's JWT, and on load, pull from Postgres the same way. Dexie stays as the local cache; Supabase becomes
the cloud store.

### Deployment rules: `database.rules.json`

This file defines who can read and write every Realtime Database path. Replace it entirely with Postgres
row-level security policies. There is no Firebase deploy step anymore. The Supabase project's RLS is the
replacement.

### What about Firebase Storage, Firestore, Analytics, and Messaging?

None of these are used by the current build. Storage is not used; the push notifications are `web-push`,
not FCM; there is no Firestore; Analytics is not wired. So there is nothing to migrate there — those rows
in the inventory are empty and can be ignored.

### Realtime subscription

There is exactly **one** realtime listener in the build: `lib/appConfig.ts` uses a Firebase Realtime Database
`onValue` listener on the `config` path, so an admin change to config propagates live without a reload. When
supabase becomes the data layer, this becomes a `postgres_changes` subscription on the `app_config` table, or
a polling refresh — choose whichever matches how often config actually changes. Everything else in the app is
a one-shot read, not a listener.

## The Supabase target — exact target surface

### Auth

Use `supabase-js` in the browser and on the server.

Providers to enable in the Supabase project dashboard:
- **Email**. This is the sign-in the app already offers.
- **Anonymous** — only if guest-first is chosen. If email-first is chosen, do not enable it.
- **Google** — only if you want a Google sign-in door. This is the thing that burned a day earlier on
  Firebase; do not assume it works out of the box. If you add it, the app needs the Google OAuth client id
  in the Supabase dashboard, and the OAuth redirect URI registered. If you are not sure, do not add it yet —
  email is enough to ship.

Config in `.env.local` / `.env`:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

That is all the app needs. No Firebase variables remain.

### Data layer

Postgres tables, one per Realtime Database tree in the current build. The owner convention is the same as
today: every user-scoped row is owned by `auth.uid()`, and the server reads and writes using the caller's JWT
so RLS is the judge.

#### Table inventory — what to create

For each, the base rule is: the row's owner column defaults to `auth.uid()`, and a policy allows the owner
to read/write and no one else. Admin-scoped rows use the admin-email policy (the same address as today).

- `profiles` — one row per user, keyed by `auth.uid()`. Holds `id`, `displayName`, `email`, created/updated.
  Replaces `users/{uid}` and `users/{uid}/profile`.
- `chats` — `id`, `owner`, `title`, `temporary`, `folder`, `parent`, `synced`, `createdAt`, `updatedAt`,
  `deletedAt`. Replaces `chats/{uid}/{chatId}`.
- `chat_messages` — `id`, `chatId`, `owner`, `role`, `content`, `model`, `usage`, `tokensIn`, `tokensOut`,
  `tokensCache`, `tokensTotal`, `createdAt`. Replaces `chats/{uid}/{chatId}/messages/{messageId}`.
- `memories` — `id`, `owner`, `content`, `createdAt`, `updatedAt`. Replaces `users/{uid}/memory`.
- `github_connections` — `id`, `owner`, `githubId`, `login`, `token` (sealed), `scopes`, `warning`,
  `connectedAt`, `updatedAt`. Replaces `users/{uid}/githubConnections/{id}`.
- `github_default` — `id`, `owner`, `connectionId`. Replaces `users/{uid}/githubDefault`.
- `projects` — `id`, `owner`, `repoFullName`, `defaultBranch`, `baseSha`, `canPush`, `addedAt`, `updatedAt`.
  Replaces `projects/{uid}/{id}`.
- `changesets` — `id`, `owner`, `repoFullName`, `baseSha`, `branch`, `title`, `files`, `createdAt`,
  `status`. Replaces `users/{uid}/changesets/{id}`.
- `approvals` — `id`, `owner`, `changesetId`, `approved`, `createdAt`. Replaces `users/{uid}/approvals/{id}`.
- `commits` — `id`, `owner`, `changesetId`, `commitSha`, `prUrl`, `createdAt`. Replaces `users/{uid}/commits/{id}`.
- `dew_credits` — `id`, `owner`, `amount`, `reason`, `createdAt`. Replaces `users/{uid}/dew`.
- `dew_spent` — `id`, `owner`, `amount`, `reason`, `createdAt`. Replaces `users/{uid}/dew/spent`.
- `dew_adjustments` — admin-side adjustments. Replaces the admin grant/burn/adjust path.
- `usage` — per-user usage records, if the current build stores usage in RTDB. Replaces `users/{uid}/usage`.
- `push_subscriptions` — `id`, `owner`, `endpoint`, `keys`, `createdAt`. Replaces `users/{uid}/push`.
- `app_config` — single-row config table, for the one realtime listener. Replaces `config`.
- `admin_registry` — admin-side registry, if the current build stores it. Replaces `admin/registry`.
- `admin_audit` — signed audit events. Replaces `admin/audit`.
- `redeem_codes` — codes the admin creates. Replaces `codes`.
- `redeems` — user redemption records. Replaces `redeems`.

For each table, write:
- Columns and types.
- Owner column default `auth.uid()`.
- RLS enable.
- A policy: owner may read and write their own rows.
- An admin policy: the admin email may read/write all rows of that table.
- Any foreign keys that make the schema clearer (chats → messages, changesets → approvals → commits).

#### Realtime

Only `app_config` needs a live listener. Implement it as a Supabase channel with `postgres_changes` on
`app_config`, or as a refresh on an interval if you prefer to avoid the subscription path. No other table
needs a listener.

### Admin access

Admin access is always by email, the same address as today, stored in `OPENMI_ADMIN_EMAIL`. In Supabase,
enforce it two ways and keep them consistent:
1. **Route-side**: the route checks the caller's email against `OPENMI_ADMIN_EMAIL`.
2. **RLS-side**: a policy on each admin table allows only the admin email.

No service-role key in the admin path. The deployment's one belongs to the background
run tick, and nothing here may use it.

## The migration order — do it in this sequence

Write the migration in three reviewed chunks. Do not do them all in one pass.

### Chunk 1 — schema, RLS, seed

1. Create the `supabase/` directory.
2. Write the Postgres schema for every table above, with owner columns defaulting to `auth.uid()`.
3. Write the RLS policies — owner-only for user tables, admin-email for admin tables.
4. Write a seed that creates the admin user (or documents how to create it) and any initial rows (config,
   redeem codes if pre-seeded).
5. Do not touch any app code yet. This chunk is only schema + RLS + seed.

At the end of chunk 1, the migration has a database that matches the current product's data model and its
access rules, and nothing in the app has changed.

### Chunk 2 — auth and the server data layer

1. Replace `lib/account.ts` with the Supabase Auth equivalent, keeping the exported function names and
   signatures where reasonable.
2. Replace `lib/rtdb.ts` and the write path in `lib/serverControl.ts` with Supabase PostgREST calls that
   forward the caller's JWT.
3. Rewrite `verifyCaller` in `lib/serverControl.ts` to validate a Supabase JWT instead of a Firebase ID token,
   keeping the `{ uid, email }` return.
4. Replace `lib/firebaseHistory.ts` with the Supabase cloud-history sync.
5. Replace `lib/firebaseAdmin.ts` with the Supabase admin queries.
6. Replace `lib/appConfig.ts`'s Firebase listener with the Supabase config watcher.

Do this chunk with the Supabase variables set but **do not deploy yet**. Run the typecheck and the tests that
cover the account module and the server control module. The account test file already has the assertions that
map backend error strings to console locations — update them for Supabase's equivalent answers instead of
Firebase's.

### Chunk 3 — the client and the deletes

1. Replace the Firebase client initialisation in `lib/firebase.ts` (or wherever the client is created) with
   the Supabase client.
2. Update the client hooks that call `onAuthStateChanged`, `getCurrentUser`, `signInAnonymously`, etc., to use
   the Supabase auth client.
3. Update the account form, the email-auth form, and any component that reads Firebase state.
4. Remove the Firebase variables from `.env.example` and from the README's current-variable table.
5. Delete `database.rules.json` from the repo (it is no longer deployed).
6. Remove the `firebase` dependency from `package.json`.
7. Update the README's sign-in and connecting-github sections for Supabase. The connecting-github section keeps
   its substance; only the "deploy database.rules.json" step drops out and is replaced by "the Supabase schema
   and RLS policies handle that".
8. Write the migration completion note in the README — a short section that says the backend is now Supabase,
   lists the Supabase variables, and points at `docs/MIGRATE_TO_SUPABASE.md` for the history.

### What gets deleted, exactly

At the end, the following are gone from the repo:

- `firebase` from `package.json`.
- All `NEXT_PUBLIC_FIREBASE_*` variables from `.env.example` and from any `.env` files (the user's own env
  stays with the values they set; this is about the shipped example and the code that reads them).
- `database.rules.json`.
- `lib/firebaseAdmin.ts`.
- `lib/firebaseHistory.ts`.
- `lib/rtdb.ts`.
- `lib/firebase.ts` or whatever file creates the Firebase app instance, once nothing imports it.
- Any Firebase-specific error text still in `lib/serverControl.ts` after the rewrite.
- The Firebase wording in the README, the GitHub-connect deploy step, and the docs that mention Firebase as
  the current backend.

Files that stay, untouched by the migration (these are not Firebase):
- The agent runtime (`lib/agent/`).
- GitHub integration (`lib/github/`, `app/api/github/*`).
- Change sets and approvals (`lib/changesets.ts`, `app/api/projects/[id]/approve/route.ts`).
- The commit path.
- The push notification sending (web-push).
- Dexie local DB.
- The model layer (`lib/providers.ts`, `lib/models.ts`).
- The Apprentice prompt code.
- The admin console UI (the component stays; only its data queries change).

## Data migration — what happens to the old data

Firebase Realtime Database has real user data in it: chats, messages, memories, Dew balances, projects, and
GitHub connections. Deciding what to do with it is part of the migration.

- **Clean start**: the Supabase tables start empty. Existing users lose their cloud history and their Dew
  balance. The app boots, signs people in, and starts fresh. This is the smaller, safer change, and it is the
  right default unless there is real user data you care about keeping.
- **Migrate by email**: for users who registered with an email, match the Firebase uid to the email, create the
  Supabase user, copy the owned rows into the new tables, and move the Dew balance. Anonymous-only users cannot
  be matched this way — there is no email to key on — so they start fresh or are left behind. GitHub
  connections need to be re-stored, because the sealed token was encrypted with the old key handling; re-pasting
  a token is the safe path.
- **Migrate everything, including guests**: requires re-creating anonymous users in Supabase (Supabase anonymous
  users are real `auth.users` rows) and copying their owned rows. This is more work and more error-prone;
  only do it if guest data matters.

State this decision in the migration document before starting. Do not attempt a migration path that silently
drops rows the admin expected to keep.

## Testing the migration

- Run the typecheck after each chunk.
- Run the account test suite after chunk 2 — the assertions that map backend answers to console locations must
  be updated to Supabase's equivalent answers.
- After chunk 3, build the production bundle and confirm the sign-in, register, verify, and reset paths work
  against the Supabase project.
- Confirm the admin console reads and writes the right rows.
- Confirm the GitHub connect path still works after the data layer changes (it should — it does not touch auth).

## How it was verified

- `bun run typecheck`, `bun run lint`, `bun run test` and `bun run build` are the gate;
  the suites that map backend answers to console locations now assert Supabase's
  answers.
- The migrations were applied against a real Postgres instance and each policy was
  exercised as the owner, as another user and as an anonymous visitor before the app
  code was pointed at it. Two things that only show up that way, and are the reason the
  schema looks the way it does:
  - Postgres filters `UPDATE` and `DELETE` through `SELECT` policies, so a table that is
    write-only by design cannot be written through PostgREST. Those writes are
    `security definer` functions instead (`deduct_dew`, `lookup_redeem_code`,
    `register_visitor`, `forget_visitor`).
  - A policy cannot see a row it is inserting, so an admin grant is a separate table
    read by a helper function, not a column the client could set.
- The GitHub connect path was re-run after the data layer changed; it does not touch
  auth, and its connection rows moved to `github_connections` unchanged in shape.
