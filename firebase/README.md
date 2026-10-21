# Firebase setup walkthrough

OpenMi uses Firebase Auth (Google + GitHub providers) and Firestore. The client
SDK only handles auth — all data flows through the Vercel Function API, and
Firestore security rules deny all client access.

## 1. Create the project

1. Go to https://console.firebase.google.com and create a project.
2. **Authentication → Sign-in method**: enable **Google** (primary sign-in) and
   **GitHub** (linked after sign-in so the agent can push).
   - For GitHub, register a new OAuth app at github.com/settings/developers with
     the callback URL shown in the Firebase console.
   - Request scopes `repo` and `read:user`.
3. **Cloud Firestore**: create a database in production mode (any region).
4. **Project settings → General → Your apps**: register a **Web app**. Note the
   `apiKey`, `authDomain`, `projectId`, and `appId`.
5. **Project settings → Service accounts → Generate new private key**. This gives
   you `client_email` and `private_key`.

## 2. Environment variables

Put these in `.env.local` (local) and in Vercel → Project → Settings →
Environment Variables (production):

| Variable | Source |
| --- | --- |
| `FIREBASE_PROJECT_ID` | Project settings → General |
| `FIREBASE_API_KEY` | Web app config |
| `FIREBASE_AUTH_DOMAIN` | Web app config (or omit — defaults to `<project>.firebaseapp.com`) |
| `FIREBASE_APP_ID` | Web app config (optional) |
| `FIREBASE_CLIENT_EMAIL` | Service account JSON |
| `FIREBASE_PRIVATE_KEY` | Service account JSON (single line, `\n` escapes on Vercel) |

## 3. Deploy rules and indexes

```bash
npm i -g firebase-tools
firebase login
cd firebase
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

The rules deny all client access (`allow read, write: if false`). The Vercel
Function uses the Admin SDK with a service account, which bypasses rules.

## 4. Authorized domains

In **Authentication → Settings → Authorized domains**, add your Vercel
production domain (and `localhost` for local dev).
