import { createMiddleware } from 'hono/factory';
import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { bearerToken, verifyAccessToken, type AuthUser } from './jwt.js';

export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: AuthUser;
    requestId: string;
  };
}

/** Attaches a correlation id to every request/response. */
export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('x-request-id')?.slice(0, 64) ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  await next();
});

/**
 * Verifies the Firebase Auth ID token and exposes the principal as `c.var.user`.
 * All app routes that touch user data must sit behind this middleware.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('authorization'));
  if (!token) {
    throw new AppError('UNAUTHENTICATED', 'Authorization header is required');
  }
  c.set('user', await verifyAccessToken(c.env, token));
  await next();
});
