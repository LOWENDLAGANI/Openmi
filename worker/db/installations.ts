import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { db } from './client';
import type { GithubInstallationRow, InstallationTokenRow } from './types';

function dbError(context: string, error: { message: string } | null): never {
  log.error('db.error', { context, message: error?.message });
  throw new AppError('INTERNAL', 'Database operation failed', {
    retryable: true,
    cause: error,
  });
}

export async function getInstallationForUser(
  env: Env,
  userId: string,
): Promise<GithubInstallationRow | null> {
  const { data, error } = await db(env)
    .from('github_installations')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) dbError('github_installations.read_user', error);
  return (data as GithubInstallationRow | null) ?? null;
}

export async function getInstallationById(
  env: Env,
  installationId: number,
): Promise<GithubInstallationRow | null> {
  const { data, error } = await db(env)
    .from('github_installations')
    .select('*')
    .eq('installation_id', installationId)
    .maybeSingle();

  if (error) dbError('github_installations.read_id', error);
  return (data as GithubInstallationRow | null) ?? null;
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
  // One linked installation per user: detach any previous one first, otherwise
  // the partial unique index rejects the upsert when someone re-installs the
  // App on a different account/organization.
  if (input.userId) {
    const { error: detachError } = await db(env)
      .from('github_installations')
      .update({ user_id: null })
      .eq('user_id', input.userId)
      .neq('installation_id', input.installationId);

    if (detachError) dbError('github_installations.detach', detachError);
  }

  const { data, error } = await db(env)
    .from('github_installations')
    .upsert(
      {
        installation_id: input.installationId,
        ...(input.userId !== undefined ? { user_id: input.userId } : {}),
        account_login: input.accountLogin,
        account_type: input.accountType ?? null,
        repository_selection: input.repositorySelection === 'all' ? 'all' : 'selected',
        suspended: input.suspended ?? false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'installation_id' },
    )
    .select('*')
    .single();

  if (error || !data) dbError('github_installations.upsert', error);
  return data as GithubInstallationRow;
}

export async function setInstallationSuspended(
  env: Env,
  installationId: number,
  suspended: boolean,
): Promise<void> {
  const { error } = await db(env)
    .from('github_installations')
    .update({ suspended, updated_at: new Date().toISOString() })
    .eq('installation_id', installationId);

  if (error) dbError('github_installations.suspend', error);
}

export async function deleteInstallation(env: Env, installationId: number): Promise<void> {
  const { error } = await db(env)
    .from('github_installations')
    .delete()
    .eq('installation_id', installationId);

  if (error) dbError('github_installations.delete', error);
}

export async function readCachedInstallationToken(
  env: Env,
  installationId: number,
): Promise<InstallationTokenRow | null> {
  const { data, error } = await db(env)
    .from('github_installation_tokens')
    .select('*')
    .eq('installation_id', installationId)
    .maybeSingle();

  if (error) dbError('installation_tokens.read', error);
  return (data as InstallationTokenRow | null) ?? null;
}

export async function saveCachedInstallationToken(
  env: Env,
  input: { installationId: number; tokenCiphertext: string; expiresAt: string },
): Promise<void> {
  const { error } = await db(env)
    .from('github_installation_tokens')
    .upsert(
      {
        installation_id: input.installationId,
        token_ciphertext: input.tokenCiphertext,
        expires_at: input.expiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'installation_id' },
    );

  if (error) dbError('installation_tokens.upsert', error);
}

export async function deleteCachedInstallationToken(
  env: Env,
  installationId: number,
): Promise<void> {
  const { error } = await db(env)
    .from('github_installation_tokens')
    .delete()
    .eq('installation_id', installationId);

  // Cache invalidation must never fail a request.
  if (error) log.warn('installation_tokens.delete_failed', { message: error.message });
}
