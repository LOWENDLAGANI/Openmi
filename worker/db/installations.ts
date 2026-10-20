import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { firestore } from './client';
import type { GithubInstallationRow, InstallationTokenRow } from './types';

function dbError(context: string, error: { message: string } | null): never {
  log.error('db.error', { context, message: error?.message });
  throw new AppError('INTERNAL', 'Database operation failed', {
    retryable: true,
    cause: error,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function getInstallationForUser(
  env: Env,
  userId: string,
): Promise<GithubInstallationRow | null> {
  const db = firestore(env);
  try {
    const snap = await db
      .collection('github_installations')
      .where('user_id', '==', userId)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const first = snap.docs[0];
    if (!first) return null;
    return first.data() as GithubInstallationRow;
  } catch (error) {
    dbError('github_installations.read_user', error as { message: string });
  }
}

export async function getInstallationById(
  env: Env,
  installationId: number,
): Promise<GithubInstallationRow | null> {
  const db = firestore(env);
  try {
    const snap = await db.doc(`github_installations/${installationId}`).get();
    if (!snap.exists) return null;
    return snap.data() as GithubInstallationRow;
  } catch (error) {
    dbError('github_installations.read_id', error as { message: string });
  }
}

/**
 * Records or claims an installation. `userId` is optional: a webhook may land
 * before the browser callback that carries the signed state.
 */
export async function upsertInstallation(
  env: Env,
  input: {
    installationId: number;
    userId?: string | null;
    accountLogin: string;
    accountType?: string | null;
    repositorySelection?: string | null;
    suspended?: boolean;
  },
): Promise<GithubInstallationRow> {
  const db = firestore(env);
  const now = nowIso();
  try {
    // One linked installation per user: detach any previous one first,
    // otherwise re-installing the App on a different account would leave a
    // stale link. Firestore has no partial unique index, so this is done in a
    // read-then-batch-update (the window is negligible for this flow).
    if (input.userId) {
      const existing = await db
        .collection('github_installations')
        .where('user_id', '==', input.userId)
        .get();
      if (!existing.empty) {
        const batch = db.batch();
        for (const doc of existing.docs) {
          if (Number(doc.id) !== input.installationId) {
            batch.update(doc.ref, { user_id: null, updated_at: now });
          }
        }
        await batch.commit();
      }
    }
    const existingSnap = await db.doc(`github_installations/${input.installationId}`).get();
    const previous = existingSnap.exists
      ? (existingSnap.data() as GithubInstallationRow)
      : null;
    const row: GithubInstallationRow = {
      installation_id: input.installationId,
      user_id: input.userId !== undefined ? input.userId : previous?.user_id ?? null,
      account_login: input.accountLogin,
      account_type: input.accountType ?? previous?.account_type ?? null,
      repository_selection:
        input.repositorySelection === 'all' ? 'all' : 'selected',
      suspended: input.suspended ?? previous?.suspended ?? false,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    };
    await db.doc(`github_installations/${input.installationId}`).set(row);
    return row;
  } catch (error) {
    dbError('github_installations.upsert', error as { message: string });
  }
}

export async function setInstallationSuspended(
  env: Env,
  installationId: number,
  suspended: boolean,
): Promise<void> {
  const db = firestore(env);
  try {
    await db
      .doc(`github_installations/${installationId}`)
      .update({ suspended, updated_at: nowIso() });
  } catch (error) {
    dbError('github_installations.suspend', error as { message: string });
  }
}

export async function deleteInstallation(env: Env, installationId: number): Promise<void> {
  const db = firestore(env);
  try {
    await db.doc(`github_installations/${installationId}`).delete();
  } catch (error) {
    dbError('github_installations.delete', error as { message: string });
  }
}

export async function readCachedInstallationToken(
  env: Env,
  installationId: number,
): Promise<InstallationTokenRow | null> {
  const db = firestore(env);
  try {
    const snap = await db.doc(`github_installation_tokens/${installationId}`).get();
    if (!snap.exists) return null;
    return snap.data() as InstallationTokenRow;
  } catch (error) {
    dbError('installation_tokens.read', error as { message: string });
  }
}

export async function saveCachedInstallationToken(
  env: Env,
  input: { installationId: number; tokenCiphertext: string; expiresAt: string },
): Promise<void> {
  const db = firestore(env);
  try {
    await db.doc(`github_installation_tokens/${input.installationId}`).set(
      {
        installation_id: input.installationId,
        token_ciphertext: input.tokenCiphertext,
        expires_at: input.expiresAt,
        updated_at: nowIso(),
      },
      { merge: true },
    );
  } catch (error) {
    dbError('installation_tokens.upsert', error as { message: string });
  }
}

export async function deleteCachedInstallationToken(
  env: Env,
  installationId: number,
): Promise<void> {
  const db = firestore(env);
  try {
    await db.doc(`github_installation_tokens/${installationId}`).delete();
  } catch (error) {
    // Cache invalidation must never fail a request.
    log.warn('installation_tokens.delete_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
