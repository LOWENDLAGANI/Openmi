import type { Context, Next } from 'hono';
import { firebaseAuth } from './firebase.js';
import { AppError } from './errors.js';
import { getOrCreateProfile } from './db/profiles.js';
import type { Profile } from '../shared/types.js';

// Cheap local shape check before any network call.
function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('UNAUTHENTICATED', 'missing bearer token');
  }
  const token = authHeader.slice(7);
  if (!looksLikeJwt(token)) {
    throw new AppError('UNAUTHENTICATED', 'malformed token');
  }
  try {
    const decoded = await firebaseAuth().verifyIdToken(token, true);
    const profile = await getOrCreateProfile(decoded.uid, {
      email: decoded.email,
      displayName: decoded.name ?? undefined,
      photoURL: decoded.picture ?? undefined,
    });
    c.set('uid', decoded.uid);
    c.set('profile', profile);
  } catch (e: any) {
    const code = e?.code ?? '';
    if (code.includes('invalid-signature') || code.includes('invalid-argument')) {
      throw new AppError('UNAUTHENTICATED', 'bad token signature');
    }
    if (code.includes('audience') || code.includes('issuer')) {
      throw new AppError('UNAUTHENTICATED', 'token issuer/audience mismatch');
    }
    if (code.includes('expired')) {
      throw new AppError('UNAUTHENTICATED', 'token expired');
    }
    throw new AppError('UNAUTHENTICATED', `token verification failed: ${e.message}`);
  }
  await next();
}

export function getUid(c: Context): string {
  return c.get('uid') as string;
}

export function getProfile(c: Context): Profile {
  return c.get('profile') as Profile;
}
