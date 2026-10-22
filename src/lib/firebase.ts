import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider, signInWithPopup, linkWithPopup, type User } from 'firebase/auth';
import type { PublicConfig } from '../../shared/types';

let inited = false;
let config: PublicConfig | undefined;

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
  const cfg = (await res.json()) as PublicConfig;
  if (!cfg.firebase?.apiKey || !cfg.firebase?.projectId) {
    throw new Error(
      'Firebase env vars are missing on Vercel. Add FIREBASE_API_KEY, FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY (and the other secrets) in Vercel → Project → Settings → Environment Variables, then redeploy.',
    );
  }
  config = cfg;
  return cfg;
}

export async function initFirebase(): Promise<void> {
  if (inited) return;
  const cfg = await getConfig();
  initializeApp({
    apiKey: cfg.firebase.apiKey,
    authDomain: cfg.firebase.authDomain,
    projectId: cfg.firebase.projectId,
    appId: cfg.firebase.appId,
  });
  inited = true;
}

export function authUser(): User | null {
  return getAuth().currentUser;
}

export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(getAuth(), provider);
  return cred.user;
}

// Link GitHub to the existing account and send the provider_token to the API.
export async function linkGithub(): Promise<void> {
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
