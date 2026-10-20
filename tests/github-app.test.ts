import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importSPKI, jwtVerify } from 'jose';
import type { GithubAppConfig } from '../worker/env';
import {
  createAppJwt,
  getAppInstallation,
  listInstallationRepos,
  mintInstallationToken,
  requireGithubApp,
} from '../worker/github/app';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const app: GithubAppConfig & { appId: string; privateKeyPem: string } = {
  enabled: true,
  appId: '123456',
  clientId: 'Iv1.abcdef',
  slug: 'openmi',
  privateKeyPem: privateKey,
  webhookSecret: 'webhook-secret',
  stateSecret: 'state-secret',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAppJwt', () => {
  it('signs an RS256 app JWT with the documented claims', async () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const token = await createAppJwt(app, now);

    const { payload, protectedHeader } = await jwtVerify(token, await importSPKI(publicKey, 'RS256'));

    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.iss).toBe('Iv1.abcdef');
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 540);
    // GitHub rejects tokens whose exp is more than 10 minutes out.
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
  });

  it('fails with a configuration error for an invalid private key', async () => {
    await expect(
      createAppJwt({ ...app, privateKeyPem: 'not-a-key' }),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});

describe('requireGithubApp', () => {
  it('throws when the app is not configured', () => {
    expect(() =>
      requireGithubApp({ ...app, enabled: false, privateKeyPem: null }),
    ).toThrowError(/not configured/i);
  });
});

describe('getAppInstallation', () => {
  it('maps a GitHub installation payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: 987,
          account: { login: 'acme', type: 'Organization' },
          repository_selection: 'all',
          suspended_at: null,
        }),
      ),
    );

    await expect(getAppInstallation(app, 987)).resolves.toEqual({
      id: 987,
      login: 'acme',
      accountType: 'Organization',
      repositorySelection: 'all',
      suspended: false,
    });
  });

  it('maps a missing installation to GITHUB_NOT_FOUND', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 404 })));
    await expect(getAppInstallation(app, 1)).rejects.toMatchObject({
      code: 'GITHUB_NOT_FOUND',
    });
  });

  it('maps server errors to a retryable GITHUB_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    await expect(getAppInstallation(app, 1)).rejects.toMatchObject({
      code: 'GITHUB_UNAVAILABLE',
      retryable: true,
    });
  });
});

describe('mintInstallationToken', () => {
  it('returns the token and its expiry', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ token: 'ghs_abc', expires_at: '2026-10-20T13:00:00Z' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(mintInstallationToken(app, 42)).resolves.toEqual({
      token: 'ghs_abc',
      expiresAt: '2026-10-20T13:00:00Z',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it('rejects a response without a token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ expires_at: 'x' })));
    await expect(mintInstallationToken(app, 42)).rejects.toMatchObject({
      code: 'GITHUB_UNAVAILABLE',
    });
  });
});

describe('listInstallationRepos', () => {
  it('maps installation repositories and their push permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          total_count: 2,
          repositories: [
            {
              full_name: 'acme/app',
              name: 'app',
              owner: { login: 'acme' },
              private: true,
              default_branch: 'main',
              permissions: { push: true },
            },
            {
              full_name: 'acme/docs',
              name: 'docs',
              owner: { login: 'acme' },
              private: false,
              default_branch: 'trunk',
              permissions: { push: false },
            },
          ],
        }),
      ),
    );

    const repos = await listInstallationRepos('ghs_token');

    expect(repos).toHaveLength(2);
    expect(repos[0]).toMatchObject({ fullName: 'acme/app', canPush: true, private: true });
    expect(repos[1]).toMatchObject({ fullName: 'acme/docs', canPush: false, defaultBranch: 'trunk' });
  });

  it('reports an expired token distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad credentials', { status: 401 })));
    await expect(listInstallationRepos('ghs_token')).rejects.toMatchObject({
      code: 'GITHUB_AUTH_EXPIRED',
    });
  });
});
