import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';

/**
 * Firebase Auth ID-token verification inside the Worker / Vercel function.
 *
 * Keyless: Google publishes the public signing keys at a stable JWKS URL, so we
 * verify signatures locally (cached) with `jose`, exactly like the original
 * Supabase path. No firebase-admin, no service account, no secret is needed to
 * verify a session. (Firestore writes still need a server identity — see
 * worker/db/client.ts, which supports keyless Workload Identity Federation.)
 *
 * The GitHub username (login) is not part of the ID token; it is persisted to
 * the user's profile by `/api/github/link` (which reads it from the GitHub API
 * using the OAuth provider token captured when GitHub is linked to the
 * signed-in account). `login` here is only a best-effort fallback (Firebase
 * `displayName` — the Google display name for Google sign-ins).
 */
export interface AuthUser {
  id: string;
  email: string | null;
  role: string;
  login: string | null;
  avatarUrl: string | null;
}

const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(projectId: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(projectId);
  if (cached) return cached;
  const set = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL), {
    cacheMaxAge: 6 * 60 * 60 * 1000, // Google rotates keys ~daily
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5000,
  });
  jwksCache.set(projectId, set);
  return set;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toAuthUser(payload: JWTPayload): AuthUser {
  return {
    id: payload.sub as string,
    email: readString(payload.email),
    role: 'authenticated',
    login: readString(payload.name),
    avatarUrl: readString(payload.picture),
  };
}

function assertUserClaims(payload: JWTPayload): void {
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new AppError('UNAUTHENTICATED', 'Token is missing a subject');
  }
}

export async function verifyAccessToken(env: Env, token: string): Promise<AuthUser> {
  const projectId = (env.FIREBASE_PROJECT_ID ?? '').trim();
  if (!projectId) {
    throw new AppError('CONFIG_ERROR', 'FIREBASE_PROJECT_ID is not configured', { status: 503 });
  }
  // Cheap local shape check so malformed tokens never hit the network.
  if (!token.includes('.') || token.split('.').length !== 3) {
    throw new AppError('UNAUTHENTICATED', 'Malformed access token');
  }
  try {
    const { payload } = await jwtVerify(token, jwksFor(projectId), {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    assertUserClaims(payload);
    return toAuthUser(payload);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired session', { cause });
  }
}

export function bearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() || null;
}
