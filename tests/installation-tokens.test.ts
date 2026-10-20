import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/env';
import { encryptSecret } from '../worker/lib/crypto';

const mocks = vi.hoisted(() => ({
  readCachedInstallationToken: vi.fn(),
  saveCachedInstallationToken: vi.fn(),
  deleteCachedInstallationToken: vi.fn(),
  mintInstallationToken: vi.fn(),
}));

vi.mock('../worker/db/installations', () => ({
  readCachedInstallationToken: mocks.readCachedInstallationToken,
  saveCachedInstallationToken: mocks.saveCachedInstallationToken,
  deleteCachedInstallationToken: mocks.deleteCachedInstallationToken,
}));

vi.mock('../worker/github/app', () => ({
  mintInstallationToken: mocks.mintInstallationToken,
  requireGithubApp: () => ({ appId: '1', privateKeyPem: 'key', enabled: true }),
}));

import {
  getInstallationToken,
  invalidateInstallationToken,
  resetInstallationTokenCache,
} from '../worker/github/installation-tokens';

const ENC_KEY = Buffer.alloc(32, 9).toString('base64');

const env = {
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  GITHUB_TOKEN_ENC_KEY: ENC_KEY,
  OPENROUTER_API_KEY: 'key',
  OPENMI_MODEL: 'test',
  DAILY_TASK_LIMIT: '5',
  MAX_CONCURRENT_TASKS: '2',
  DEFAULT_COMMIT_MODE: 'direct',
  GITHUB_APP_ID: '123456',
  GITHUB_APP_CLIENT_ID: 'Iv1.abc',
  GITHUB_APP_SLUG: 'openmi',
  GITHUB_APP_PRIVATE_KEY: 'unused-in-this-test',
  GITHUB_APP_WEBHOOK_SECRET: 'hook',
} as unknown as Env;

function inMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetInstallationTokenCache();
  mocks.readCachedInstallationToken.mockResolvedValue(null);
  mocks.saveCachedInstallationToken.mockResolvedValue(undefined);
  mocks.deleteCachedInstallationToken.mockResolvedValue(undefined);
  mocks.mintInstallationToken.mockResolvedValue({
    token: 'ghs_fresh',
    expiresAt: inMinutes(60),
  });
});

describe('getInstallationToken', () => {
  it('mints once, caches encrypted, and reuses the warm token', async () => {
    const first = await getInstallationToken(env, 42);
    const second = await getInstallationToken(env, 42);

    expect(first).toBe('ghs_fresh');
    expect(second).toBe('ghs_fresh');
    expect(mocks.mintInstallationToken).toHaveBeenCalledTimes(1);

    const saved = mocks.saveCachedInstallationToken.mock.calls[0]?.[1];
    expect(saved.tokenCiphertext).not.toContain('ghs_fresh');
    expect(typeof saved.expiresAt).toBe('string');
    expect(Date.parse(saved.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('reuses a valid token from Postgres without minting', async () => {
    const ciphertext = await encryptSecret(ENC_KEY, 'ghs_cached');
    mocks.readCachedInstallationToken.mockResolvedValue({
      installation_id: 42,
      token_ciphertext: ciphertext,
      expires_at: inMinutes(30),
      updated_at: '',
    });

    await expect(getInstallationToken(env, 42)).resolves.toBe('ghs_cached');
    expect(mocks.mintInstallationToken).not.toHaveBeenCalled();
  });

  it('refreshes a token inside the safety margin', async () => {
    const ciphertext = await encryptSecret(ENC_KEY, 'ghs_expiring');
    mocks.readCachedInstallationToken.mockResolvedValue({
      installation_id: 42,
      token_ciphertext: ciphertext,
      expires_at: inMinutes(2),
      updated_at: '',
    });

    await expect(getInstallationToken(env, 42)).resolves.toBe('ghs_fresh');
    expect(mocks.mintInstallationToken).toHaveBeenCalledTimes(1);
  });

  it('re-mints when the stored ciphertext cannot be decrypted', async () => {
    mocks.readCachedInstallationToken.mockResolvedValue({
      installation_id: 42,
      token_ciphertext: 'v1.bad.bad',
      expires_at: inMinutes(30),
      updated_at: '',
    });

    await expect(getInstallationToken(env, 42)).resolves.toBe('ghs_fresh');
    expect(mocks.mintInstallationToken).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent cold misses', async () => {
    mocks.mintInstallationToken.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ token: 'ghs_fresh', expiresAt: inMinutes(60) }), 10),
        ),
    );

    const results = await Promise.all([
      getInstallationToken(env, 7),
      getInstallationToken(env, 7),
      getInstallationToken(env, 7),
    ]);

    expect(results).toEqual(['ghs_fresh', 'ghs_fresh', 'ghs_fresh']);
    expect(mocks.mintInstallationToken).toHaveBeenCalledTimes(1);
  });

  it('keeps installations isolated from each other', async () => {
    mocks.mintInstallationToken
      .mockResolvedValueOnce({ token: 'ghs_first', expiresAt: inMinutes(60) })
      .mockResolvedValueOnce({ token: 'ghs_second', expiresAt: inMinutes(60) });

    await expect(getInstallationToken(env, 1)).resolves.toBe('ghs_first');
    await expect(getInstallationToken(env, 2)).resolves.toBe('ghs_second');
  });
});

describe('invalidateInstallationToken', () => {
  it('clears both cache layers', async () => {
    await getInstallationToken(env, 42);
    await invalidateInstallationToken(env, 42);

    expect(mocks.deleteCachedInstallationToken).toHaveBeenCalledWith(env, 42);

    await getInstallationToken(env, 42);
    expect(mocks.mintInstallationToken).toHaveBeenCalledTimes(2);
  });
});
