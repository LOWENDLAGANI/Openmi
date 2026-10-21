import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  linkWithRedirect,
  reauthenticateWithRedirect,
  setPersistence,
  signInWithRedirect,
  type Auth,
  type AuthProvider,
  type User,
  type UserCredential,
} from 'firebase/auth';
import type { FirebaseClientConfigView } from '@shared/types';

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;

/**
 * Initializes (once) the Firebase client SDK from the public config handed out
 * by /api/config. The service account is never present in the browser.
 */
export function initFirebase(config: FirebaseClientConfigView): {
  app: FirebaseApp;
  auth: Auth;
} {
  if (appInstance && authInstance) return { app: appInstance, auth: authInstance };
  const app = initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    ...(config.appId ? { appId: config.appId } : {}),
    ...(config.messagingSenderId ? { messagingSenderId: config.messagingSenderId } : {}),
  });
  const auth = getAuth(app);
  // Guarantee the session survives the full-page redirect of the OAuth flow.
  // Mobile/in-app browsers may default to session-only or blocked storage;
  // explicitly requesting local persistence keeps the user signed in after
  // the provider redirects back. Best-effort here; the redirect starters
  // await it again right before navigating away.
  void setPersistence(auth, browserLocalPersistence).catch(() => {});
  appInstance = app;
  authInstance = auth;
  return { app, auth };
}

/**
 * Which OAuth redirect is in flight. It survives the redirect (same origin)
 * and is consumed on return, so the app can tell a sign-in attempt from a
 * GitHub link attempt when diagnosing a silent break.
 * sessionStorage is the right scope: cleared when the tab closes.
 */
export type OAuthFlow = 'signin' | 'link';

const OAUTH_PENDING_KEY = 'openmi:oauthPending';

function beginOAuthFlow(flow: OAuthFlow): void {
  try {
    sessionStorage.setItem(OAUTH_PENDING_KEY, flow);
  } catch {
    /* storage unavailable — diagnostic only */
  }
}

/** Clears a stale "OAuth in flight" marker without reading it. */
export function clearOAuthFlow(): void {
  try {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Returns the in-flight flow, and clears the marker atomically. */
export function consumeOAuthFlow(): OAuthFlow | null {
  try {
    const value = sessionStorage.getItem(OAUTH_PENDING_KEY);
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    return value === 'signin' || value === 'link' ? value : null;
  } catch {
    return null;
  }
}

/** Resolves persistence, marks the flow, then navigates away — in that order. */
async function startRedirect(auth: Auth, provider: AuthProvider, flow: OAuthFlow): Promise<void> {
  // Must resolve before the redirect navigates away; if persistence is still
  // in-memory at that point, the session vanishes when the provider redirects
  // back and the user lands on the login screen again.
  await setPersistence(auth, browserLocalPersistence);
  // On return, if Firebase reports no user and no redirect result (a silent
  // break, e.g. wrong callback URL), the app can surface a diagnostic instead
  // of bouncing to login with no explanation.
  beginOAuthFlow(flow);
  try {
    if (flow === 'signin') {
      await signInWithRedirect(auth, provider);
      return;
    }
    // Account linking — GitHub joins the signed-in Google session instead of
    // starting (or replacing) one.
    const user = auth.currentUser;
    if (!user) throw new Error('Your session ended. Sign in again to connect GitHub.');
    try {
      await linkWithRedirect(user, provider);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'auth/provider-already-linked') throw error;
      // GitHub is already on this Firebase account but the server never got
      // the token (e.g. the earlier link request failed). Re-authenticate
      // instead: it also returns through getRedirectResult with a fresh token.
      await reauthenticateWithRedirect(user, provider);
    }
  } catch (error) {
    // The redirect never started, so nothing will come back to consume the
    // marker; leaving it set would fire a false diagnostic on the next load.
    clearOAuthFlow();
    throw error;
  }
}

/**
 * Google OAuth through Firebase — the only way to sign in. Uses the redirect
 * flow (mobile-friendly). No provider token needs to be captured here; the
 * session alone is enough for the workspace to load.
 */
export async function signInWithGoogle(auth: Auth): Promise<void> {
  const provider = new GoogleAuthProvider();
  await startRedirect(auth, provider, 'signin');
}

/**
 * Links the GitHub provider to the ALREADY signed-in user (account linking,
 * not sign-in) so a Google session can never be replaced by a GitHub one.
 * The `repo` scope is required: the background agent pushes commits with the
 * provider token minted here, which the redirect result hands to
 * /api/github/link. Preferred path for repo access stays the GitHub App; this
 * is the OAuth fallback for deployments without one.
 */
export async function linkGithub(auth: Auth): Promise<void> {
  const provider = new GithubAuthProvider();
  provider.addScope('repo');
  provider.addScope('read:user');
  provider.setCustomParameters({ allow_signup: 'false' });
  await startRedirect(auth, provider, 'link');
}

/**
 * Extracts the GitHub OAuth access token from a post-redirect link (or
 * reauthenticate) result.
 *
 * The modular SDK does NOT put the credential on `UserCredential` — the
 * supported accessor is `GithubAuthProvider.credentialFromResult`, which reads
 * the internal `_tokenResponse.oauthAccessToken`. Two guards matter:
 *
 * - results with `operationType === 'signIn'` are never GitHub tokens here
 *   (sign-in is Google-only), and `credentialFromResult` would stamp ANY
 *   response's `oauthAccessToken` — including a Google one — as `github.com`;
 * - a structural `result.credential.accessToken` fallback covers SDK shapes
 *   that do expose `credential` directly.
 */
export function githubProviderTokenFrom(result: unknown): string | null {
  if (!result) return null;
  const operationType = (result as { operationType?: unknown }).operationType;
  if (operationType === 'signIn') return null;
  try {
    const credential = GithubAuthProvider.credentialFromResult(result as UserCredential);
    const token = credential?.accessToken;
    if (typeof token === 'string' && token.length > 0 && credential?.providerId === 'github.com') {
      return token;
    }
  } catch {
    /* result carries no token response — try the structural shape below */
  }
  const credential = (
    result as
      | { credential?: { providerId?: unknown; accessToken?: unknown } | null }
      | null
  )?.credential;
  const token = credential?.accessToken;
  if (typeof token !== 'string' || token.length === 0) return null;
  const providerId = credential?.providerId;
  if (typeof providerId === 'string' && providerId.length > 0 && providerId !== 'github.com') {
    return null;
  }
  return token;
}

export type { Auth, User };
