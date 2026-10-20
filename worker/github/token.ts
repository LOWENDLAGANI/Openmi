import type { Env } from '../env';
import { loadConfig } from '../env';
import { decryptSecret } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { getGithubCredential } from '../db/users';

/**
 * Decrypts the user's GitHub token inside the caller (never in workflow state,
 * never in a step return value, never in a response).
 */
export async function getGithubToken(env: Env, userId: string): Promise<string> {
  const credential = await getGithubCredential(env, userId);
  if (!credential) {
    throw new AppError('GITHUB_NOT_CONNECTED', 'Connect GitHub before running a task', {
      status: 409,
    });
  }
  const { githubTokenEncKey } = loadConfig(env);
  return decryptSecret(githubTokenEncKey, credential.token_ciphertext);
}
