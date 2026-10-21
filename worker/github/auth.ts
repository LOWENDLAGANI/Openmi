import type { Env } from '../env.js';
import { loadConfig } from '../env.js';
import { getInstallationForUser } from '../db/installations.js';
import { getGithubCredential } from '../db/users.js';
import { decryptSecret } from '../lib/crypto.js';
import { AppError, isAppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { getInstallationToken } from './installation-tokens.js';

/**
 * One seam for "how may the agent act on GitHub for this user?".
 * Phase 2 prefers a GitHub App installation (per-repo, revocable, no re-auth)
 * and falls back to a stored OAuth token for users who have not installed the
 * App yet.
 */

export type GithubAuthKind = 'github_app' | 'oauth';

export interface GithubAuth {
  kind: GithubAuthKind;
  token: string;
  login: string;
  installationId?: number;
}

/** Failures that mean "this installation is gone", not "GitHub is down". */
function isDeadInstallation(error: unknown): boolean {
  return (
    isAppError(error) &&
    (error.code === 'GITHUB_AUTH_EXPIRED' || error.code === 'GITHUB_NOT_FOUND')
  );
}

export async function resolveGithubAuth(env: Env, userId: string): Promise<GithubAuth> {
  const config = loadConfig(env);

  if (config.githubApp.enabled) {
    const installation = await getInstallationForUser(env, userId);
    if (installation && !installation.suspended) {
      try {
        const token = await getInstallationToken(env, installation.installation_id);
        return {
          kind: 'github_app',
          token,
          login: installation.account_login,
          installationId: installation.installation_id,
        };
      } catch (error) {
        if (!isDeadInstallation(error)) throw error;
        log.warn('github.installation_unusable', {
          installationId: installation.installation_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const credential = await getGithubCredential(env, userId);
  if (!credential) {
    throw new AppError(
      'GITHUB_NOT_CONNECTED',
      config.githubApp.enabled
        ? 'Install the OpenMi GitHub App on a repository, or reconnect GitHub'
        : 'Connect GitHub before running a task',
    );
  }

  return {
    kind: 'oauth',
    token: await decryptSecret(config.githubTokenEncKey, credential.token_ciphertext),
    login: credential.github_login,
  };
}

/** Cheap availability check: never mints a token. */
export async function hasGithubAuth(env: Env, userId: string): Promise<boolean> {
  const config = loadConfig(env);
  if (config.githubApp.enabled) {
    const installation = await getInstallationForUser(env, userId);
    if (installation && !installation.suspended) return true;
  }
  const credential = await getGithubCredential(env, userId);
  return Boolean(credential);
}
