import type { Env } from '../env';
import { loadConfig } from '../env';
import {
  deleteCachedInstallationToken,
  readCachedInstallationToken,
  saveCachedInstallationToken,
} from '../db/installations';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { log } from '../lib/logger';
import { mintInstallationToken, requireGithubApp } from './app';

/**
 * Installation tokens live for ~1 hour and are reusable across concurrent
 * requests. Caching is two-level:
 *   1. a per-isolate Map (free, warm path)
 *   2. Postgres with encrypted ciphertext (survives isolate restarts and is
 *      shared across colos), which matters because every workflow step may run
 *      in a different isolate.
 * Tokens are treated as opaque and refreshed five minutes before expiry.
 */

const SAFETY_MARGIN_MS = 5 * 60 * 1000;

interface MemoryEntry {
  token: string;
  expiresAt: number;
}

const memory = new Map<number, MemoryEntry>();
const inflight = new Map<number, Promise<string>>();

function isFresh(expiresAt: number, now: number): boolean {
  return Number.isFinite(expiresAt) && expiresAt - SAFETY_MARGIN_MS > now;
}

export async function getInstallationToken(env: Env, installationId: number): Promise<string> {
  const now = Date.now();
  const cached = memory.get(installationId);
  if (cached && isFresh(cached.expiresAt, now)) return cached.token;

  // Single-flight per isolate: a burst of requests must not mint in parallel.
  const pending = inflight.get(installationId);
  if (pending) return pending;

  const task = (async () => {
    const config = loadConfig(env);
    const app = requireGithubApp(config.githubApp);

    const stored = await readCachedInstallationToken(env, installationId);
    if (stored) {
      const expiresAt = Date.parse(stored.expires_at);
      if (isFresh(expiresAt, Date.now())) {
        try {
          const token = await decryptSecret(config.githubTokenEncKey, stored.token_ciphertext);
          memory.set(installationId, { token, expiresAt });
          return token;
        } catch (error) {
          log.warn('github.cached_token_unreadable', {
            installationId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const minted = await mintInstallationToken(app, installationId);
    const expiresAt = Date.parse(minted.expiresAt);
    const ciphertext = await encryptSecret(config.githubTokenEncKey, minted.token);

    await saveCachedInstallationToken(env, {
      installationId,
      tokenCiphertext: ciphertext,
      expiresAt: minted.expiresAt,
    });

    if (Number.isFinite(expiresAt)) memory.set(installationId, { token: minted.token, expiresAt });
    log.info('github.installation_token_minted', { installationId });
    return minted.token;
  })().finally(() => inflight.delete(installationId));

  inflight.set(installationId, task);
  return task;
}

export async function invalidateInstallationToken(
  env: Env,
  installationId: number,
): Promise<void> {
  memory.delete(installationId);
  await deleteCachedInstallationToken(env, installationId);
}

/** Test seam: clears isolate-level caches. */
export function resetInstallationTokenCache(): void {
  memory.clear();
  inflight.clear();
}
