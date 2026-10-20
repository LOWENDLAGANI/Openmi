import { Hono } from 'hono';
import type { ConfigStatusView } from '../../shared/types';
import type { AppEnv } from '../auth/middleware';
import { missingConfig } from '../env';

export const healthRoutes = new Hono<AppEnv>();

/**
 * Public liveness/config probe. Never reveals secret values, only which
 * configuration keys are still missing so setup failures are obvious.
 */
healthRoutes.get('/config', (c) => {
  const missing = missingConfig(c.env);
  return c.json(
    {
      supabaseUrl: c.env.SUPABASE_URL ?? '',
      supabaseAnonKey: c.env.SUPABASE_ANON_KEY ?? '',
      version: '0.1.0',
      ready: missing.length === 0,
      missing,
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
