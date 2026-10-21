import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, GithubAuthProvider, signInWithPopup, linkWithPopup, type User } from 'firebase/auth';
import type { PublicConfig } from '../../shared/types';

let inited = false;
let config: PublicConfig | undefined;

export async function getConfig(): Promise<PublicConfig> {
  if (config) return config;
  const res = await fetch('/api/config');
  config = await res.json();
  return config;
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
