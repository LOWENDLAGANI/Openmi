import { Hono } from 'hono';
import type { MeView, QuotaView } from '../../shared/types';
import type { AppEnv } from '../auth/middleware';
import { getInstallationForUser } from '../db/installations';
import { ensureProfile, getDailyUsage, getGithubCredential } from '../db/users';
import { loadConfig } from '../env';
import { nextUtcMidnight } from '../lib/time';

export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/me', async (c) => {
  const user = c.var.user;
  const config = loadConfig(c.env);

  const profile = await ensureProfile(c.env, {
    id: user.id,
    login: user.login,
    avatarUrl: user.avatarUrl,
  });
  const [used, credential, installation] = await Promise.all([
    getDailyUsage(c.env, user.id),
    getGithubCredential(c.env, user.id),
    getInstallationForUser(c.env, user.id),
  ]);

  const quota: QuotaView = {
    used,
    limit: config.dailyTaskLimit,
    remaining: Math.max(0, config.dailyTaskLimit - used),
    resetsAt: nextUtcMidnight(),
  };

  const body: MeView = {
    user: {
      id: user.id,
      email: user.email,
      login: profile.github_login ?? user.login,
      avatarUrl: profile.avatar_url ?? user.avatarUrl,
    },
    quota,
    github: installation && !installation.suspended
      ? {
          login: installation.account_login,
          scopes: [],
          updatedAt: installation.updated_at,
          kind: 'github_app',
          installationId: installation.installation_id,
        }
      : credential
        ? {
            login: credential.github_login,
            scopes: Array.isArray(credential.scopes) ? credential.scopes : [],
            updatedAt: credential.updated_at,
            kind: 'oauth',
          }
        : null,
  };

  c.header('cache-control', 'private, no-store');
  return c.json(body);
});
