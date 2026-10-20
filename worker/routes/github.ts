import { Hono } from 'hono';
import { z } from 'zod';
import type { GithubRepoView } from '../../shared/types';
import type { AppEnv } from '../auth/middleware';
import { ensureProfile, saveGithubCredential } from '../db/users';
import { createOctokit, mapGithubError } from '../github/client';
import { getAuthenticatedLogin, listUserRepos } from '../github/repo';
import { getGithubToken } from '../github/token';
import { encryptSecret } from '../lib/crypto';
import { loadConfig } from '../env';
import { AppError } from '../lib/errors';
import { readJson } from '../lib/http';

export const githubRoutes = new Hono<AppEnv>();

const linkSchema = z.object({
  providerToken: z.string().min(20).max(500),
});

/**
 * Persists the GitHub OAuth token obtained during Supabase sign-in.
 *
 * Phase 2 replaces this with a GitHub App installation token so access is
 * per-repository and revocable without re-authenticating. Until then, tokens
 * are encrypted with AES-256-GCM and only ever decrypted inside a workflow step.
 */
githubRoutes.post('/github/link', async (c) => {
  const user = c.var.user;
  const { providerToken } = await readJson(c, linkSchema);
  const config = loadConfig(c.env);

  let identity: { login: string; scopes: string[] };
  try {
    identity = await getAuthenticatedLogin(createOctokit(providerToken));
  } catch (error) {
    throw mapGithubError(error, 'github.link');
  }

  const hasRepoScope = identity.scopes.includes('repo') || identity.scopes.includes('public_repo');
  if (!hasRepoScope) {
    throw new AppError(
      'GITHUB_FORBIDDEN',
      'GitHub did not grant repository access. Sign in again and approve repo permissions.',
    );
  }

  const ciphertext = await encryptSecret(config.githubTokenEncKey, providerToken);
  const credential = await saveGithubCredential(c.env, {
    userId: user.id,
    login: identity.login,
    tokenCiphertext: ciphertext,
    scopes: identity.scopes,
  });

  await ensureProfile(c.env, { id: user.id, login: identity.login, avatarUrl: user.avatarUrl });

  c.header('cache-control', 'private, no-store');
  return c.json({
    login: credential.github_login,
    scopes: credential.scopes,
    updatedAt: credential.updated_at,
  });
});

githubRoutes.get('/github/repos', async (c) => {
  const user = c.var.user;
  const token = await getGithubToken(c.env, user.id);
  const repos: GithubRepoView[] = await listUserRepos(token);

  c.header('cache-control', 'private, no-store');
  return c.json({ repos });
});
