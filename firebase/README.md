# Firebase setup

OpenMi uses Firebase Auth (GitHub sign-in) and Firestore on the server
(Vercel / Node, via `firebase-admin`). The browser only uses the Firebase JS
SDK for sign-in; all data flows through the `/api/*` endpoints.

## 1. Create the project

1. Create a Firebase project at <https://console.firebase.google.com>.
2. Enable **Authentication** → Sign-in method → **GitHub**. Register a GitHub
   OAuth app (callback URL shown in the Firebase console) and request the
   `repo` and `read:user` scopes.
3. Enable **Cloud Firestore** (production mode).
4. Project settings → **Service accounts** → Generate new private key. This
   gives you `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`.
5. Project settings → **General** → Your apps → register a web app. This gives
   you `FIREBASE_API_KEY` and `FIREBASE_APP_ID`; `FIREBASE_AUTH_DOMAIN` is
   `<project-id>.firebaseapp.com` (set it only if you use a custom domain).
6. Add your Vercel domain to **Authentication** → Settings →
   Authorized domains.

## 2. Deploy rules and indexes

With the Firebase CLI (`npm i -g firebase-tools`), from this directory:

```bash
firebase login
firebase use <project-id>
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

`firestore.rules` denies all direct client access (the Admin SDK bypasses
rules). `firestore.indexes.json` provisions the composite indexes the API
queries rely on (active-task counts, project/task listings, stale-lease scan).

## 3. Data model (collections)

| Collection / document | Purpose |
| --- | --- |
| `users/{uid}` | Profile (github login, avatar). Doc id = Firebase uid. |
| `github_credentials/{uid}` | Encrypted OAuth token fallback (AES-256-GCM). |
| `projects/{uuid}` | One per (owner, repo). Uniqueness enforced via `project_index/{owner}:{repo}` in a transaction. |
| `tasks/{uuid}` | Task state incl. `lease_expires_at` (serverless ownership lease). |
| `tasks/{uuid}/events/{autoId}` | Append-only timeline shown on the phone. |
| `usage_daily/{uid}:{YYYY-MM-DD}` | Daily quota counters; incremented inside a transaction. |
| `github_installations/{installationId}` | GitHub App installation records. |
| `github_installation_tokens/{installationId}` | Cached, encrypted installation tokens. |

## 4. Leases & quotas on Firestore

- **Lease** (`leaseTask`): a Firestore transaction reads the task doc, and
  only the invocation that observes `queued` — or `running` with an expired
  `lease_expires_at` — may write a fresh lease. Two concurrent runners can
  never both claim the same task, which is what protects against Vercel
  timeouts and duplicate work.
- **Quota** (`consumeTaskQuota`): a transaction on `usage_daily/{uid}:{day}`
  checks `tasks_started < limit` and increments atomically, so the last slot
  can never be double-spent. `refundTaskQuota` decrements in a transaction
  (floored at 0).
