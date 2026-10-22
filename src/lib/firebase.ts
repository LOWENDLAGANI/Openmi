import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithPopup,
  linkWithPopup,
  type Auth,
  type User,
} from 'firebase/auth';
import type { PublicConfig } from '../../shared/types';

let config: PublicConfig | undefined;
// The in-flight initialisation, shared by every caller. Without it, React's
// StrictMode double-mount (and any second caller) reaches initializeApp()
// twice: one call wins, the other rejects with `app/duplicate-app`.
let initPromise: Promise<void> | undefined;

export async function getConfig(): Promise<PublicConfig> {
  if (config) return config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res: Response;
  try {
    res = await fetch('/api/config', { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`API is unreachable (HTTP ${res.status}) — check the Vercel deployment`);
  }
  // If /api/config is served by the SPA fallback (wrong rewrite, wrong origin),
  // the response is HTML and res.json() would throw a raw parse error.
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      `The API did not return JSON (content-type: ${contentType || 'unknown'}) — /api/config is being served by something other than the API function. Check the deployment's rewrite rules and that the SPA and the API share an origin.`,
    );
  }
  let cfg: PublicConfig;
  try {
    cfg = (await res.json()) as PublicConfig;
  } catch {
    throw new Error('The API returned a malformed /api/config response — check the deployment.');
  }
  if (!cfg.firebase?.apiKey || !cfg.firebase?.projectId) {
    throw new Error(
      'Firebase env vars are missing on Vercel. Add FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (and the other secrets) in Vercel → Project → Settings → Environment Variables, then redeploy.',
    );
  }
  config = cfg;
  return cfg;
}

// Idempotent: safe to call any number of times, from any number of callers.
export async function initFirebase(): Promise<void> {
  if (getApps().length > 0) return;
  if (!initPromise) {
    initPromise = (async () => {
      const cfg = await getConfig();
      try {
        initializeApp({
          apiKey: cfg.firebase.apiKey,
          authDomain: cfg.firebase.authDomain,
          projectId: cfg.firebase.projectId,
          appId: cfg.firebase.appId,
        });
      } catch (e: any) {
        throw new Error(
          `Firebase could not be initialised: ${e?.message ?? e}. Check FIREBASE_API_KEY / FIREBASE_PROJECT_ID / FIREBASE_AUTH_DOMAIN on the deployment.`,
        );
      }
    })().catch((e) => {
      // A failed attempt must not poison the app: allow a later retry.
      initPromise = undefined;
      throw e;
    });
  }
  return initPromise;
}

// The Firebase Auth instance, or an actionable error. The raw SDK error
// ("app/no-app: No Firebase App '[DEFAULT]' has been created") says nothing
// about the cause — usually a failed /api/config fetch at startup.
export function firebaseAuth(): Auth {
  const app = getApps()[0];
  if (!app) {
    throw new Error(
      'Firebase is not initialised yet: the app could not load /api/config. Check that the API is reachable (this page and the API share a deployment) and that FIREBASE_API_KEY and FIREBASE_PROJECT_ID are set, then reload.',
    );
  }
  return getAuth(app);
}

export function authUser(): User | null {
  return firebaseAuth().currentUser;
}

export async function signInWithGoogle(): Promise<User> {
  // Initialise on demand: if the config could not be loaded, report that
  // instead of failing later with an opaque SDK error.
  await initFirebase();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(firebaseAuth(), provider);
  return cred.user;
}

// Link GitHub to the existing account and send the provider_token to the API.
export async function linkGithub(): Promise<void> {
  await initFirebase();
  const provider = new GithubAuthProvider();
  provider.addScope('repo');
  provider.addScope('read:user');
  const user = authUser();
  if (!user) throw new Error('not signed in');
  const cred = await linkWithPopup(user, provider);
  const token = (cred as any)._tokenResponse?.oauthAccessToken ?? (cred as any).credential?.accessToken;
  if (token) {
    const idToken = await user.getIdToken();
    await fetch('/api/github/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ token, scopes: 'repo,read:user' }),
    });
  }
}
