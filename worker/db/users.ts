import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { nextUtcMidnight, todayUtc } from '../lib/time';
import { db } from './client';
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

export async function ensureProfile(
  env: Env,
  user: { id: string; login: string | null; avatarUrl: string | null },
): Promise<ProfileRow> {
  const { data, error } = await db(env)
    .from('profiles')
    .upsert(
      {
        id: user.id,
        github_login: user.login,
        avatar_url: user.avatarUrl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
    .select('*')
    .single();

  if (error || !data) dbError('profiles.upsert', error);
  return data as ProfileRow;
}

export async function getDailyUsage(env: Env, userId: string): Promise<number> {
  const today = todayUtc();
  const { data, error } = await db(env)
    .from('usage_daily')
    .select('tasks_started')
    .eq('user_id', userId)
    .eq('day', today)
    .maybeSingle();

  if (error) dbError('usage_daily.read', error);
  return (data as Pick<UsageRow, 'tasks_started'> | null)?.tasks_started ?? 0;
}

/**
 * Atomically reserves one task from the user's daily budget.
 * The check-and-increment happens in a single SQL statement, so two concurrent
 * requests can never both observe the last remaining slot.
 */
export async function consumeTaskQuota(
  env: Env,
  userId: string,
  limit: number,
): Promise<QuotaSnapshot> {
  const { data, error } = await db(env).rpc('consume_task_quota', {
    p_user_id: userId,
    p_limit: limit,
  });

  if (error) dbError('consume_task_quota', error);

  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; used: number; limit: number }
    | undefined;

  if (!row) throw new AppError('INTERNAL', 'Quota function returned no result');

  return {
    allowed: Boolean(row.allowed),
    used: Number(row.used),
    limit: Number(row.limit ?? limit),
    remaining: Math.max(0, Number(row.limit ?? limit) - Number(row.used)),
    resetsAt: nextUtcMidnight(),
  };
}

/** Gives a slot back after a failure that was our fault, not the user's. */
export async function refundTaskQuota(env: Env, userId: string): Promise<void> {
  const { error } = await db(env).rpc('refund_task_quota', { p_user_id: userId });
  if (error) log.error('quota.refund_failed', { message: error.message, userId });
}

export async function countActiveTasks(env: Env, userId: string): Promise<number> {
  const { count, error } = await db(env)
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId)
    .in('status', ['queued', 'running']);

  if (error) dbError('tasks.count_active', error);
  return count ?? 0;
}

export async function getGithubCredential(
  env: Env,
  userId: string,
): Promise<GithubCredentialRow | null> {
  const { data, error } = await db(env)
    .from('github_credentials')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) dbError('github_credentials.read', error);
  return (data as GithubCredentialRow | null) ?? null;
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
  const { data, error } = await db(env)
    .from('github_credentials')
    .upsert(
      {
        user_id: input.userId,
        github_login: input.login,
        token_ciphertext: input.tokenCiphertext,
        scopes: input.scopes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('*')
    .single();

  if (error || !data) dbError('github_credentials.upsert', error);
  return data as GithubCredentialRow;
}
