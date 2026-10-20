import type { Env } from '../env';
import { firebaseAuth } from '../db/client';
import { AppError } from '../lib/errors';

/**
 * Firebase Auth ID-token verification inside the Worker / Vercel function.
 *
 * `firebase-admin`'s `verifyIdToken` validates signature, issuer, audience and
 * expiry against Google's cached public keys (no per-request Auth call). A
 * cheap local shape check runs first so malformed tokens are rejected without
 * any network round-trip.
 *
 * The GitHub username (login) is not part of the ID token; it is persisted to
 * the user's profile by `/api/github/link` (which reads it from the GitHub API
 * using the OAuth provider token captured at sign-in). `login` here is only a
 * best-effort fallback (Firebase `displayName`).
 */
export interface AuthUser {
  id: string;
  email: string | null;
  role: string;
  login: string | null;
  avatarUrl: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Rejects obviously malformed tokens locally before any network call. */
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    ) as { alg?: unknown };
    return typeof header.alg === 'string' && header.alg.length > 0;
  } catch {
    return false;
  }
}

export async function verifyAccessToken(env: Env, token: string): Promise<AuthUser> {
  if (!looksLikeJwt(token)) {
    throw new AppError('UNAUTHENTICATED', 'Malformed access token');
  }
  let decoded: {
    uid: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  try {
    decoded = await firebaseAuth(env).verifyIdToken(token, true);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired session', { cause });
  }
  if (typeof decoded.uid !== 'string' || decoded.uid.length === 0) {
    throw new AppError('UNAUTHENTICATED', 'Token is missing a subject');
  }
  return {
    id: decoded.uid,
    email: readString(decoded.email),
    role: 'authenticated',
    login: readString(decoded.name),
    avatarUrl: readString(decoded.picture),
  };
}

export function bearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() || null;
}
