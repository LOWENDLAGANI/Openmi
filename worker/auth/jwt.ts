import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../env';
import { AppError } from '../lib/errors';

/**
 * Supabase access-token verification inside the Worker.
 *
 * Production path: asymmetric signing keys verified locally against the
 * project JWKS (no per-request call to the Auth server).
 * Dev-only path: legacy HS256 shared secret, enabled solely when
 * `SUPABASE_JWT_SECRET` is present so local integration tests can mint tokens.
 */

export interface AuthUser {
  id: string;
  email: string | null;
  role: string;
  login: string | null;
  avatarUrl: string | null;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(supabaseUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const url = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  const cached = jwksCache.get(url);
  if (cached) return cached;
  const set = createRemoteJWKSet(new URL(url), {
    cacheMaxAge: 10 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  });
  jwksCache.set(url, set);
  return set;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toAuthUser(payload: JWTPayload): AuthUser {
  const metadata = (payload.user_metadata ?? {}) as Record<string, unknown>;
  const login =
    readString(metadata.user_name) ??
    readString(metadata.preferred_username) ??
    readString(metadata.login);

  return {
    id: payload.sub as string,
    email: readString(payload.email),
    role: readString(payload.role) ?? 'authenticated',
    login,
    avatarUrl: readString(metadata.avatar_url),
  };
}

function assertUserClaims(payload: JWTPayload): void {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new AppError('UNAUTHENTICATED', 'Token is missing a subject');
  }
  if (payload.role !== 'authenticated') {
    throw new AppError('UNAUTHENTICATED', 'Token is not a user session token');
  }
}

export async function verifyAccessToken(env: Env, token: string): Promise<AuthUser> {
  const supabaseUrl = env.SUPABASE_URL?.replace(/\/+$/, '');
  if (!supabaseUrl) {
    throw new AppError('CONFIG_ERROR', 'SUPABASE_URL is not configured', { status: 503 });
  }

  const issuer = `${supabaseUrl}/auth/v1`;
  const audience = 'authenticated';

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Malformed access token');
  }

  try {
    // Algorithm pinning: each branch has exactly one verifier, so a token can
    // never fall back from one algorithm to another.
    if (header.alg === 'ES256' || header.alg === 'RS256') {
      const { payload } = await jwtVerify(token, jwksFor(supabaseUrl), {
        algorithms: ['ES256', 'RS256'],
        issuer,
        audience,
      });
      assertUserClaims(payload);
      return toAuthUser(payload);
    }

    if (header.alg === 'HS256' && env.SUPABASE_JWT_SECRET) {
      const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer,
        audience,
      });
      assertUserClaims(payload);
      return toAuthUser(payload);
    }
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired session', { cause });
  }

  throw new AppError('UNAUTHENTICATED', 'Unsupported token algorithm');
}

export function bearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() || null;
}
