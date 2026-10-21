import { Hono } from 'hono';
import type { ConfigStatusView } from '../../shared/types.js';
import type { AppEnv } from '../auth/middleware.js';
import { firebaseClientConfig, missingConfig, resolveGithubAppConfig } from '../env.js';

export const healthRoutes = new Hono<AppEnv>();

/**
 * Public liveness/config probe. Never reveals secret values (service account
 * email/private key), only the public Firebase web config and which keys are
 * still missing so setup failures are obvious.
 */
healthRoutes.get('/config', (c) => {
  const missing = missingConfig(c.env);
  const githubApp = resolveGithubAppConfig(c.env);
  // Canonical origin the app should be served from. Sessions and the OAuth
  // redirect flag are origin-bound; serving the app on multiple origins (www
  // vs apex, http vs https, vercel.app vs custom domain) silently drops the
  // session on redirect return. Handed to the client so it can redirect to a
  // single origin before any auth flow starts.
  const appOrigin = c.env.APP_ORIGIN?.trim().replace(/\/+$/, '') ?? null;
  return c.json(
    {
      firebase: firebaseClientConfig(c.env),
      version: '0.1.0',
      ready: missing.length === 0,
      missing,
      githubApp: { enabled: githubApp.enabled, slug: githubApp.slug },
      appOrigin,
    },
    200,
    { 'cache-control': 'public, max-age=60' },
  );
});

healthRoutes.get('/health', (c) => {
  const missing = missingConfig(c.env);
  const body: ConfigStatusView = {
    ok: missing.length === 0,
    version: '0.1.0',
    missing,
  };
  return c.json(body, 200);
});
