import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/env';
import { encryptSecret } from '../worker/lib/crypto';
import { AppError } from '../worker/lib/errors';

const mocks = vi.hoisted(() => ({
  getInstallationForUser: vi.fn(),
  getGithubCredential: vi.fn(),
  getInstallationToken: vi.fn(),
}));

vi.mock('../worker/db/installations', () => ({
  getInstallationForUser: mocks.getInstallationForUser,
}));

vi.mock('../worker/db/users', () => ({
  getGithubCredential: mocks.getGithubCredential,
}));

vi.mock('../worker/github/installation-tokens', () => ({
  getInstallationToken: mocks.getInstallationToken,
}));

import { hasGithubAuth, resolveGithubAuth } from '../worker/github/auth';

const ENC_KEY = Buffer.alloc(32, 4).toString('base64');
const USER = '11111111-1111-4111-8111-111111111111';

function makeEnv(appEnabled: boolean): Env {
  return {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    GITHUB_TOKEN_ENC_KEY: ENC_KEY,
    OPENROUTER_API_KEY: 'key',
    OPENMI_MODEL: 'test',
    DAILY_TASK_LIMIT: '5',
    MAX_CONCURRENT_TASKS: '2',
    DEFAULT_COMMIT_MODE: 'direct',
    ...(appEnabled
      ? {
          GITHUB_APP_ID: '123456',
          GITHUB_APP_SLUG: 'openmi',
          GITHUB_APP_PRIVATE_KEY: 'pkcs8',
          GITHUB_APP_WEBHOOK_SECRET: 'hook',
        }
      : {}),
  } as unknown as Env;
}

const installation = {
  installation_id: 555,
  user_id: USER,
  account_login: 'acme',
  account_type: 'Organization',
  repository_selection: 'selected' as const,
  suspended: false,
  created_at: '',
  updated_at: '',
};

async function oauthCredential(login = 'octocat') {
  return {
    user_id: USER,
    github_login: login,
    token_ciphertext: await encryptSecret(ENC_KEY, 'gho_oauth'),
    scopes: ['repo'],
    updated_at: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getInstallationForUser.mockResolvedValue(null);
  mocks.getGithubCredential.mockResolvedValue(null);
  mocks.getInstallationToken.mockResolvedValue('ghs_installation');
});

describe('resolveGithubAuth', () => {
  it('prefers a live App installation', async () => {
    mocks.getInstallationForUser.mockResolvedValue(installation);
    mocks.getGithubCredential.mockResolvedValue(await oauthCredential());

    await expect(resolveGithubAuth(makeEnv(true), USER)).resolves.toEqual({
      kind: 'github_app',
      token: 'ghs_installation',
      login: 'acme',
      installationId: 555,
    });
    expect(mocks.getInstallationToken).toHaveBeenCalledWith(expect.anything(), 555);
  });

  it('falls back to OAuth when no installation exists', async () => {
    mocks.getGithubCredential.mockResolvedValue(await oauthCredential());

    await expect(resolveGithubAuth(makeEnv(true), USER)).resolves.toMatchObject({
      kind: 'oauth',
      token: 'gho_oauth',
      login: 'octocat',
    });
  });

  it('falls back to OAuth when the installation was revoked on GitHub', async () => {
    mocks.getInstallationForUser.mockResolvedValue(installation);
    mocks.getGithubCredential.mockResolvedValue(await oauthCredential());
    mocks.getInstallationToken.mockRejectedValue(
      new AppError('GITHUB_AUTH_EXPIRED', 'GitHub rejected the App credentials'),
    );

    await expect(resolveGithubAuth(makeEnv(true), USER)).resolves.toMatchObject({
      kind: 'oauth',
    });
  });

  it('does not silently hide transient GitHub failures', async () => {
    mocks.getInstallationForUser.mockResolvedValue(installation);
    mocks.getGithubCredential.mockResolvedValue(await oauthCredential());
    mocks.getInstallationToken.mockRejectedValue(
      new AppError('GITHUB_UNAVAILABLE', 'GitHub is down', { retryable: true }),
    );

    await expect(resolveGithubAuth(makeEnv(true), USER)).rejects.toMatchObject({
      code: 'GITHUB_UNAVAILABLE',
    });
  });

  it('ignores a suspended installation', async () => {
    mocks.getInstallationForUser.mockResolvedValue({ ...installation, suspended: true });
    mocks.getGithubCredential.mockResolvedValue(await oauthCredential());

    await expect(resolveGithubAuth(makeEnv(true), USER)).resolves.toMatchObject({
      kind: 'oauth',
    });
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it('uses OAuth when the App is not configured at all', async () => {
    mocks.getInstallationForUser.mockResolvedValue(installation);
    mocks.getGithubCredential.mockResolvedValue(await oauthCredential());

    await expect(resolveGithubAuth(makeEnv(false), USER)).resolves.toMatchObject({
      kind: 'oauth',
    });
  });

  it('throws GITHUB_NOT_CONNECTED when nothing is linked', async () => {
    await expect(resolveGithubAuth(makeEnv(true), USER)).rejects.toMatchObject({
      code: 'GITHUB_NOT_CONNECTED',
    });
  });
});

describe('hasGithubAuth', () => {
  it('is true for a live installation without minting a token', async () => {
    mocks.getInstallationForUser.mockResolvedValue(installation);
    await expect(hasGithubAuth(makeEnv(true), USER)).resolves.toBe(true);
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it('is false for a suspended installation with no OAuth credential', async () => {
    mocks.getInstallationForUser.mockResolvedValue({ ...installation, suspended: true });
    await expect(hasGithubAuth(makeEnv(true), USER)).resolves.toBe(false);
  });

  it('is true when only an OAuth credential exists', async () => {
    mocks.getGithubCredential.mockResolvedValue(await oauthCredential());
    await expect(hasGithubAuth(makeEnv(true), USER)).resolves.toBe(true);
  });
});
