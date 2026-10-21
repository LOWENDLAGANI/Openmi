import { collections } from '../firebase.js';
import { encryptToken, decryptToken } from '../crypto.js';

// GitHub OAuth credentials (fallback path). 1:1 with uid.
// Stored as AES-256-GCM ciphertext + scopes. Never returned in plaintext.

export interface StoredCredential {
  uid: string;
  ciphertext: string;
  scopes: string[];
  createdAt: number;
}

export async function storeGithubCredential(
  uid: string,
  token: string,
  scopes: string[],
): Promise<void> {
  await collections.githubCredentials().doc(uid).set({
    uid,
    ciphertext: encryptToken(token),
    scopes,
    createdAt: new Date(),
  });
}

export async function getGithubCredential(uid: string): Promise<{ token: string; scopes: string[] } | undefined> {
  const snap = await collections.githubCredentials().doc(uid).get();
  if (!snap.exists) return undefined;
  const data = snap.data()!;
  return { token: decryptToken(data.ciphertext), scopes: data.scopes ?? [] };
}

export async function hasGithubCredential(uid: string): Promise<boolean> {
  const snap = await collections.githubCredentials().doc(uid).get();
  return snap.exists;
}
