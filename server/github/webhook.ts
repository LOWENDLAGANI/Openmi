import crypto from 'node:crypto';
import { timingSafeEqual } from '../crypto.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';

// Verify X-Hub-Signature-256 over the raw request body.
export async function verifyGithubWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<void> {
  const secret = env.githubAppWebhookSecret();
  if (!secret) throw new AppError('CONFIG_ERROR', 'GITHUB_APP_WEBHOOK_SECRET not set');
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    throw new AppError('FORBIDDEN', 'missing or malformed hub signature');
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (!timingSafeEqual(expected, provided)) {
    throw new AppError('FORBIDDEN', 'webhook signature mismatch');
  }
}

// Signed install-state: HMAC of {userId, expiry, nonce}. 15 min TTL.
export interface InstallState {
  userId: string;
  expiry: number;
  nonce: string;
}

function stateSecret(): string {
  const s = env.githubAppStateSecret();
  if (!s) throw new AppError('CONFIG_ERROR', 'GITHUB_APP_STATE_SECRET (or webhook secret) not set');
  return s;
}

export function signInstallState(userId: string): string {
  const expiry = Date.now() + 15 * 60 * 1000;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = JSON.stringify({ userId, expiry, nonce });
  const sig = crypto.createHmac('sha256', stateSecret()).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

export function verifyInstallState(token: string): InstallState {
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) throw new AppError('FORBIDDEN', 'malformed install state');
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const expected = crypto.createHmac('sha256', stateSecret()).update(payload).digest('hex');
  if (!timingSafeEqual(expected, sig)) {
    throw new AppError('FORBIDDEN', 'install state signature mismatch');
  }
  const state = JSON.parse(payload) as InstallState;
  if (state.expiry < Date.now()) {
    throw new AppError('FORBIDDEN', 'install state expired');
  }
  return state;
}
