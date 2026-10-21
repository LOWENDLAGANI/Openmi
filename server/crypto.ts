import crypto from 'node:crypto';
import { AppError } from './errors.js';

// AES-256-GCM envelope encryption for stored GitHub tokens (OAuth + installation).
// Ciphertext layout: base64( iv(12) || authTag(16) || ciphertext ).

function key(): Buffer {
  const b64 = process.env.GITHUB_TOKEN_ENC_KEY;
  if (!b64) throw new AppError('CONFIG_ERROR', 'GITHUB_TOKEN_ENC_KEY not set');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new AppError('CONFIG_ERROR', 'GITHUB_TOKEN_ENC_KEY must be 32 bytes (base64)');
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptToken(envelope: string): string {
  const buf = Buffer.from(envelope, 'base64');
  if (buf.length < 12 + 16 + 1) {
    throw new AppError('INTERNAL', 'stored token envelope is malformed');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function randomHex(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}
