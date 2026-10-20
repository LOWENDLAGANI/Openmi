import {
  base64UrlDecode,
  base64UrlEncode,
  base64UrlToBytes,
  bytesToBase64Url,
} from '../lib/base64';
import { AppError } from '../lib/errors';

/**
 * The GitHub App install flow returns the user to our callback with an
 * `installation_id` that GitHub warns can be spoofed. We therefore carry a
 * short-lived, HMAC-signed state issued only to an authenticated session, and
 * treat that as the attribution for the installation.
 */

const encoder = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

const DEFAULT_TTL_MS = 15 * 60 * 1000;

interface StatePayload {
  u: string;
  e: number;
  n: string;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const created = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  keyCache.set(secret, created);
  return created;
}

export async function signInstallState(
  secret: string,
  userId: string,
  options: { now?: number; ttlMs?: number; nonce?: string } = {},
): Promise<string> {
  if (!secret) throw new AppError('CONFIG_ERROR', 'Install state secret is not configured');

  const now = options.now ?? Date.now();
  const payload: StatePayload = {
    u: userId,
    e: now + (options.ttlMs ?? DEFAULT_TTL_MS),
    n: options.nonce ?? crypto.randomUUID(),
  };

  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(encoded),
  );

  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyInstallState(
  secret: string,
  state: string,
  now: number = Date.now(),
): Promise<{ userId: string }> {
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError('BAD_REQUEST', 'Invalid install state');
  }
  const [encoded, signature] = parts as [string, string];

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      base64UrlToBytes(signature),
      encoder.encode(encoded),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new AppError('BAD_REQUEST', 'Install state signature is invalid');

  let payload: StatePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as StatePayload;
  } catch {
    throw new AppError('BAD_REQUEST', 'Install state is malformed');
  }

  if (typeof payload.u !== 'string' || typeof payload.e !== 'number') {
    throw new AppError('BAD_REQUEST', 'Install state is incomplete');
  }
  if (payload.e <= now) {
    throw new AppError('BAD_REQUEST', 'Install state expired; start the install again');
  }

  return { userId: payload.u };
}
