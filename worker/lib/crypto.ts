import { base64UrlToBytes, bytesToBase64Url } from './base64.js';
import { AppError } from './errors.js';

/**
 * AES-256-GCM envelope for secrets at rest (GitHub OAuth tokens).
 * Format: `v1.<base64url iv>.<base64url ciphertext>`.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BITS = 128;

const keyCache = new Map<string, Promise<CryptoKey>>();

async function getKey(base64Key: string): Promise<CryptoKey> {
  const cached = keyCache.get(base64Key);
  if (cached) return cached;

  const created = (async () => {
    let raw: Uint8Array;
    try {
      raw = base64UrlToBytes(base64Key);
    } catch {
      throw new AppError('CONFIG_ERROR', 'GITHUB_TOKEN_ENC_KEY is not valid base64', {
        status: 503,
      });
    }
    if (raw.byteLength !== KEY_BYTES) {
      throw new AppError(
        'CONFIG_ERROR',
        `GITHUB_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${raw.byteLength})`,
        { status: 503 },
      );
    }
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  })();

  keyCache.set(base64Key, created);
  return created;
}

export async function encryptSecret(base64Key: string, plaintext: string): Promise<string> {
  const key = await getKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_BITS },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(base64Key: string, payload: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new AppError('CONFIG_ERROR', 'Stored GitHub token is malformed', { status: 503 });
  }
  const key = await getKey(base64Key);
  const [ivPart, cipherPart] = [parts[1] as string, parts[2] as string];

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlToBytes(ivPart), tagLength: TAG_BITS },
      key,
      base64UrlToBytes(cipherPart),
    );
    return new TextDecoder().decode(plaintext);
  } catch (cause) {
    throw new AppError(
      'GITHUB_AUTH_EXPIRED',
      'Stored GitHub token could not be decrypted; reconnect GitHub',
      { status: 401, cause },
    );
  }
}

/** Deterministic short id, safe for branch names and log correlation. */
export function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
