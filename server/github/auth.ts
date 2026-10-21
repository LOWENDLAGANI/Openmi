import crypto from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { env } from '../env.js';
import { AppError } from '../errors.js';
import {
  getInstallationForUser,
  storeInstallationToken,
  getInstallationToken,
  evictInstallationToken,
} from '../db/installations.js';
import { getGithubCredential } from '../db/credentials.js';

// In-memory cache + single-flight. Warm across invocations that land on the
// same isolate; Firestore is the shared cold store.
const memCache = new Map<number, { token: string; expiresAt: number }>();
const inflight = new Map<number, Promise<{ token: string; expiresAt: number }>>();

export interface GithubAuthResult {
  token: string;
  kind: 'installation' | 'oauth';
  installationId?: number;
}

// Sign a GitHub App JWT (RS256). Valid for 10 min per GitHub's guidance.
export function signAppJwt(): string {
  const appId = env.githubAppId();
  const privateKey = env.githubAppPrivateKey();
  if (!appId || !privateKey) {
    throw new AppError('CONFIG_ERROR', 'GitHub App is not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const header = { alg: 'RS256', typ: 'JWT' };
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const sig = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey);
  return `${signingInput}.${sig.toString('base64url')}`;
}

function appClient(): Octokit {
  return new Octokit({ auth: signAppJwt() });
}

async function mintInstallationToken(installationId: number): Promise<{ token: string; expiresAt: number }> {
  const { data } = await appClient().apps.createInstallationAccessToken({
    installation_id: installationId,
  });
  const expiresAt = new Date(data.expires_at).getTime();
  return { token: data.token, expiresAt };
}

async function getCachedInstallationToken(
  installationId: number,
): Promise<{ token: string; expiresAt: number }> {
  const now = Date.now();
  const STALE_MS = 5 * 60 * 1000; // treat as stale 5 min before expiry

  const mem = memCache.get(installationId);
  if (mem && mem.expiresAt - now > STALE_MS) return mem;

  const db = await getInstallationToken(installationId);
  if (db && db.expiresAt - now > STALE_MS) {
    memCache.set(installationId, db);
    return db;
  }

  // Single-flight mint.
  let p = inflight.get(installationId);
  if (!p) {
    p = (async () => {
      try {
        const fresh = await mintInstallationToken(installationId);
        memCache.set(installationId, fresh);
        await storeInstallationToken(installationId, fresh.token, fresh.expiresAt);
        return fresh;
      } finally {
        inflight.delete(installationId);
      }
    })();
    inflight.set(installationId, p);
  }
  return p;
}

// The single seam: how may this user's agent write to GitHub?
// App installation preferred; OAuth fallback. Transient GitHub failures
// propagate (never silently downgrade).
export async function resolveGithubAuth(userId: string): Promise<GithubAuthResult> {
  if (env.githubAppId() && env.githubAppPrivateKey()) {
    const inst = await getInstallationForUser(userId);
    if (inst && !inst.suspended) {
      try {
        const { token } = await getCachedInstallationToken(inst.installationId);
        return { token, kind: 'installation', installationId: inst.installationId };
      } catch (e: any) {
        const status = e?.status ?? e?.response?.status;
        // Revoked / not found fall back to OAuth. Transient errors propagate.
        if (status === 404 || status === 403 || status === 401) {
          await evictInstallationToken(inst.installationId);
          // fall through to OAuth
        } else {
          throw new AppError('GITHUB_UNAVAILABLE', `installation token mint failed: ${e.message}`, {
            retryable: true,
          });
        }
      }
    }
  }

  const cred = await getGithubCredential(userId);
  if (!cred) {
    throw new AppError('GITHUB_NOT_CONNECTED', 'no GitHub credential linked');
  }
  return { token: cred.token, kind: 'oauth' };
}

export function octokitFor(token: string): Octokit {
  return new Octokit({ auth: token });
}

// Call with an installation token; on 401 evict and re-mint exactly once.
export async function withInstallationToken<T>(
  installationId: number,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  let { token } = await getCachedInstallationToken(installationId);
  try {
    return await fn(token);
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status;
    if (status === 401) {
      await evictInstallationToken(installationId);
      memCache.delete(installationId);
      const fresh = await getCachedInstallationToken(installationId);
      return fn(fresh.token);
    }
    throw e;
  }
}
