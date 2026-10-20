import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GithubAuthProvider,
  signInWithRedirect,
  type Auth,
  type User,
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
  appInstance = app;
  authInstance = auth;
  return { app, auth };
}

/**
 * GitHub OAuth through Firebase. The `repo` scope is required: the background
 * agent pushes commits with the provider token minted here.
 *
 * Uses the redirect flow (mobile-friendly). On return, `getRedirectResult` in
 * the app context captures the GitHub provider token and forwards it to
 * /api/github/link, exactly as the Supabase PKCE flow did.
 */
export async function signInWithGithub(auth: Auth): Promise<void> {
  const provider = new GithubAuthProvider();
  provider.addScope('repo');
  provider.addScope('read:user');
  provider.setCustomParameters({ allow_signup: 'false' });
  await signInWithRedirect(auth, provider);
}

/**
 * Extracts the GitHub OAuth access token from a post-redirect sign-in result.
 * Firebase types `UserCredential.credential` as the base `AuthCredential`,
 * which does not expose `accessToken`, and the exact shape varies across SDK
 * versions, so a structural cast is used.
 */
export function githubProviderTokenFrom(result: unknown): string | null {
  const credential = (result as { credential?: { accessToken?: unknown } | null } | null)
    ?.credential;
  const token = credential?.accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export type { Auth, User };
