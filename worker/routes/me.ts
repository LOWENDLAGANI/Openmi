import { Hono } from 'hono';
import type { MeView, QuotaView } from '../../shared/types.js';
import type { AppEnv } from '../auth/middleware.js';
import { getInstallationForUser } from '../db/installations.js';
import { ensureProfile, getDailyUsage, getGithubCredential } from '../db/users.js';
import { loadConfig } from '../env.js';
import { nextUtcMidnight } from '../lib/time.js';

export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/me', async (c) => {
  const user = c.var.user;
  const config = loadConfig(c.env);

  const profile = await ensureProfile(c.env, {
    id: user.id,
    // `login: null` never overwrites github_login. The ID-token name claim is
    // the Google display name for Google sign-ins, and the GitHub login is
    // only ever written by POST /github/link (the linking step) — reading the
    // profile here must not clobber it with the Google name.
    login: null,
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
