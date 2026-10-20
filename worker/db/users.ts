import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { nextUtcMidnight, todayUtc } from '../lib/time';
import { firestore } from './client';
import type { GithubCredentialRow, ProfileRow, UsageRow } from './types';

function dbError(context: string, error: { message: string } | null): never {
  log.error('db.error', { context, message: error?.message });
  throw new AppError('INTERNAL', 'Database operation failed', {
    retryable: true,
    cause: error,
  });
}

export interface QuotaSnapshot {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function ensureProfile(
  env: Env,
  user: { id: string; login: string | null; avatarUrl: string | null },
): Promise<ProfileRow> {
  const db = firestore(env);
  const ref = db.doc(`users/${user.id}`);
  try {
    const snap = await ref.get();
    const now = nowIso();
    if (snap.exists) {
      const existing = snap.data() as ProfileRow;
      const next: ProfileRow = {
        id: user.id,
        github_login: user.login ?? existing.github_login,
        avatar_url: user.avatarUrl ?? existing.avatar_url,
        created_at: existing.created_at,
        updated_at: now,
      };
      await ref.set(
        {
          github_login: next.github_login,
          avatar_url: next.avatar_url,
          updated_at: now,
        },
        { merge: true },
      );
      return next;
    }
    const row: ProfileRow = {
      id: user.id,
      github_login: user.login,
      avatar_url: user.avatarUrl,
      created_at: now,
      updated_at: now,
    };
    await ref.set(row);
    return row;
  } catch (error) {
    dbError('users.upsert', error as { message: string });
  }
}

export async function getDailyUsage(env: Env, userId: string): Promise<number> {
  const db = firestore(env);
  const day = todayUtc();
  try {
    const snap = await db.doc(`usage_daily/${userId}:${day}`).get();
    if (!snap.exists) return 0;
    return Number((snap.data() as Pick<UsageRow, 'tasks_started'>).tasks_started ?? 0);
  } catch (error) {
    dbError('usage_daily.read', error as { message: string });
  }
}

/**
 * Atomically reserves one task from the user's daily budget.
 *
 * The check-and-increment happens inside a single Firestore transaction, so
 * two concurrent requests can never both observe the last remaining slot.
 */
export async function consumeTaskQuota(
  env: Env,
  userId: string,
  limit: number,
): Promise<QuotaSnapshot> {
  const db = firestore(env);
  const day = todayUtc();
  const usageRef = db.doc(`usage_daily/${userId}:${day}`);
  try {
    const row = await db.runTransaction(async (t) => {
      const snap = await t.get(usageRef);
      const data = snap.exists ? (snap.data() as Partial<UsageRow>) : undefined;
      const used = Number(data?.tasks_started ?? 0);
      if (used >= limit) {
        return { allowed: false, used, limit };
      }
      t.set(
        usageRef,
        {
          user_id: userId,
          day,
          tasks_started: used + 1,
          ai_calls: Number(data?.ai_calls ?? 0),
          updated_at: nowIso(),
        },
        { merge: true },
      );
      return { allowed: true, used: used + 1, limit };
    });
    return {
      allowed: Boolean(row.allowed),
      used: Number(row.used),
      limit: Number(row.limit),
      remaining: Math.max(0, Number(row.limit) - Number(row.used)),
      resetsAt: nextUtcMidnight(),
    };
  } catch (error) {
    dbError('consume_task_quota', error as { message: string });
  }
}

/** Gives a slot back after a failure that was our fault, not the user's. */
export async function refundTaskQuota(env: Env, userId: string): Promise<void> {
  const db = firestore(env);
  const day = todayUtc();
  const usageRef = db.doc(`usage_daily/${userId}:${day}`);
  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(usageRef);
      if (!snap.exists) return;
      const used = Number((snap.data() as Pick<UsageRow, 'tasks_started'>).tasks_started ?? 0);
      t.update(usageRef, {
        tasks_started: Math.max(0, used - 1),
        updated_at: nowIso(),
      });
    });
  } catch (error) {
    log.error('quota.refund_failed', {
      message: error instanceof Error ? error.message : String(error),
      userId,
    });
  }
}

export async function countActiveTasks(env: Env, userId: string): Promise<number> {
  const db = firestore(env);
  try {
    const snap = await db
      .collection('tasks')
      .where('owner_id', '==', userId)
      .where('status', 'in', ['queued', 'running'])
      .count()
      .get();
    return Number(snap.data().count ?? 0);
  } catch (error) {
    dbError('tasks.count_active', error as { message: string });
  }
}

export async function getGithubCredential(
  env: Env,
  userId: string,
): Promise<GithubCredentialRow | null> {
  const db = firestore(env);
  try {
    const snap = await db.doc(`github_credentials/${userId}`).get();
    if (!snap.exists) return null;
    return snap.data() as GithubCredentialRow;
  } catch (error) {
    dbError('github_credentials.read', error as { message: string });
  }
}

export async function saveGithubCredential(
  env: Env,
  input: {
    userId: string;
    login: string;
    tokenCiphertext: string;
    scopes: string[];
  },
): Promise<GithubCredentialRow> {
  const db = firestore(env);
  const now = nowIso();
  const row: GithubCredentialRow = {
    user_id: input.userId,
    github_login: input.login,
    token_ciphertext: input.tokenCiphertext,
    scopes: input.scopes,
    updated_at: now,
  };
  try {
    await db.doc(`github_credentials/${input.userId}`).set(row, { merge: true });
    return row;
  } catch (error) {
    dbError('github_credentials.upsert', error as { message: string });
  }
}
