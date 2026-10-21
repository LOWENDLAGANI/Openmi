import { collections } from '../firebase.js';
import { encryptToken, decryptToken } from '../crypto.js';

// GitHub App installations. userId is nullable until the signed callback
// claims it (webhook may arrive first).

export interface InstallationRecord {
  installationId: number;
  userId?: string;
  accountLogin?: string;
  suspended: boolean;
  createdAt: number;
  updatedAt: number;
}

export async function recordInstallation(
  installationId: number,
  patch: Partial<InstallationRecord>,
): Promise<void> {
  const ref = collections.githubInstallations().doc(String(installationId));
  await ref.set(
    { installationId, ...patch, updatedAt: new Date() },
    { merge: true },
  );
}

export async function getInstallationForUser(userId: string): Promise<InstallationRecord | undefined> {
  const snap = await collections
    .githubInstallations()
    .where('userId', '==', userId)
    .where('suspended', '==', false)
    .limit(1)
    .get();
  if (snap.empty) return undefined;
  const d = snap.docs[0].data() as any;
  return {
    installationId: d.installationId,
    userId: d.userId,
    accountLogin: d.accountLogin,
    suspended: !!d.suspended,
    createdAt: d.createdAt?.toMillis?.() ?? d.createdAt,
    updatedAt: d.updatedAt?.toMillis?.() ?? d.updatedAt,
  };
}

export async function claimInstallation(installationId: number, userId: string): Promise<void> {
  await collections.githubInstallations().doc(String(installationId)).set(
    { userId, suspended: false, updatedAt: new Date() },
    { merge: true },
  );
}

// Installation token cache (encrypted). Keyed by installationId.
export async function storeInstallationToken(
  installationId: number,
  token: string,
  expiresAt: number,
): Promise<void> {
  await collections.githubInstallationTokens().doc(String(installationId)).set({
    installationId,
    ciphertext: encryptToken(token),
    expiresAt: new Date(expiresAt),
    updatedAt: new Date(),
  });
}

export async function getInstallationToken(
  installationId: number,
): Promise<{ token: string; expiresAt: number } | undefined> {
  const snap = await collections.githubInstallationTokens().doc(String(installationId)).get();
  if (!snap.exists) return undefined;
  const data = snap.data()!;
  const expiresAt = data.expiresAt?.toMillis?.() ?? data.expiresAt;
  return { token: decryptToken(data.ciphertext), expiresAt };
}

export async function evictInstallationToken(installationId: number): Promise<void> {
  await collections.githubInstallationTokens().doc(String(installationId)).delete();
}
