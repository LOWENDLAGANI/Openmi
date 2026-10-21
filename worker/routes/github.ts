import { Hono } from 'hono';
import { z } from 'zod';
import type { GithubRepoView } from '../../shared/types.js';
import type { AppEnv } from '../auth/middleware.js';
import { ensureProfile, saveGithubCredential } from '../db/users.js';
import { loadConfig } from '../env.js';
import { AppError } from '../lib/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { readJson } from '../lib/http.js';
import { createOctokit, mapGithubError } from '../github/client.js';
import { listInstallationRepos } from '../github/app.js';
import { resolveGithubAuth } from '../github/auth.js';
import { getAuthenticatedLogin, listUserRepos } from '../github/repo.js';
import { signInstallState } from '../github/state.js';

export const githubRoutes = new Hono<AppEnv>();

const linkSchema = z.object({
  providerToken: z.string().min(20).max(800),
});

/**
 * Persists the GitHub OAuth token obtained when the user LINKS GitHub to
 * their (Google-signed-in) Firebase account — GitHub is never a sign-in
 * method itself.
 *
 * This remains as the fallback path for users without a GitHub App
 * installation. When the App is configured, repo writes use installation
 * tokens instead and this credential is only used to list repositories.
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

  const hasRepoScope =
    identity.scopes.includes('repo') || identity.scopes.includes('public_repo');
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
    kind: 'oauth' as const,
  });
});

/** Returns a GitHub-hosted install URL carrying our signed attribution state. */
githubRoutes.post('/github/app/install', async (c) => {
  const config = loadConfig(c.env);
  if (!config.githubApp.enabled || !config.githubApp.slug || !config.githubApp.stateSecret) {
    throw new AppError('CONFIG_ERROR', 'GitHub App is not configured on this deployment', {
      status: 503,
    });
  }

  const state = await signInstallState(config.githubApp.stateSecret, c.var.user.id);
  const url = `https://github.com/apps/${encodeURIComponent(config.githubApp.slug)}/installations/new?state=${encodeURIComponent(state)}`;

  c.header('cache-control', 'private, no-store');
  return c.json({ url });
});

githubRoutes.get('/github/repos', async (c) => {
  const auth = await resolveGithubAuth(c.env, c.var.user.id);

  // Installation tokens can only see repositories the App was granted.
  const repos: GithubRepoView[] =
    auth.kind === 'github_app'
      ? await listInstallationRepos(auth.token)
      : await listUserRepos(auth.token);

  c.header('cache-control', 'private, no-store');
  return c.json({ repos });
});
