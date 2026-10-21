import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ApiErrorBody } from '../shared/types.js';
import { requestContext, requireAuth, type AppEnv } from './auth/middleware.js';
import { toAppError } from './lib/errors.js';
import { log } from './lib/logger.js';
import { githubAppRoutes } from './routes/github-app.js';
import { internalRoutes } from './routes/internal.js';
import { githubRoutes } from './routes/github.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { projectRoutes } from './routes/projects.js';
import { taskRoutes } from './routes/tasks.js';

const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-frame-options', 'DENY');
  c.header('cross-origin-resource-policy', 'same-origin');
});

const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header('cache-control', 'private, no-store');
});

/**
 * Every path prefix that must be behind a verified session.
 *
 * Hono runs wildcard middleware before handlers, so auth cannot be mounted as a
 * catch-all sub-app: it would also guard the public health/config endpoints.
 * New protected routes must be added here (tests/api.test.ts fails otherwise).
 */
const PROTECTED_PREFIXES = [
  '/me',
  '/github',
  '/github/*',
  '/projects',
  '/projects/*',
  '/tasks',
  '/tasks/*',
];

export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', requestContext);
app.use('*', securityHeaders);

// Public endpoints
app.route('/', healthRoutes);
// GitHub App callback + webhook authenticate themselves (signed state / HMAC),
// so they sit outside the bearer-token prefix below.
app.route('/', githubAppRoutes);
// Runner + cron endpoints: authenticated by internal/cron secrets, not sessions.
app.route('/', internalRoutes);

// Authenticated endpoints. Registered per prefix: Hono's `use()` takes exactly
// one path followed by handlers, so a spread path list would be treated as
// handlers.
for (const prefix of PROTECTED_PREFIXES) {
  app.use(prefix, requireAuth);
  app.use(prefix, noStore);
}

app.route('/', meRoutes);
app.route('/', githubRoutes);
app.route('/', projectRoutes);
app.route('/', taskRoutes);

app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/api' || path.startsWith('/api/')) {
    return c.json<ApiErrorBody>(
      { error: { code: 'NOT_FOUND', message: 'Unknown API endpoint' } },
      404,
    );
  }
  // Hand non-API misses to the asset handler so SPA routes still resolve.
  // On Vercel the function only ever receives /api/* requests; static paths are
  // served by the platform, so a missing binding is not an error there.
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.text('Not Found', 404);
});

app.onError((error, c) => {
  const requestId = c.get('requestId');
  const appError = toAppError(error);

  if (appError.status >= 500) {
    log.error('api.error', {
      requestId,
      code: appError.code,
      message: appError.message,
      path: new URL(c.req.url).pathname,
      cause: appError.cause instanceof Error ? appError.cause.message : undefined,
    });
  } else {
    log.warn('api.rejected', {
      requestId,
      code: appError.code,
      message: appError.message,
      path: new URL(c.req.url).pathname,
    });
  }

  // Errors are never cacheable — including auth failures that short-circuit
  // before the per-route no-store middleware can run.
  c.header('cache-control', 'private, no-store');
  return c.json(appError.toWire(requestId), appError.status as 400);
});
