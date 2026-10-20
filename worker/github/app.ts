import { SignJWT, importPKCS8 } from 'jose';
import type { GithubRepoView } from '../../shared/types';
import type { GithubAppConfig } from '../env';
import { AppError } from '../lib/errors';

/**
 * GitHub App server-to-server auth:
 *   RS256 app JWT (<=10 min) -> installation access token (~1 h) -> REST/Git Data.
 *
 * The app JWT proves we are the App; the installation token proves which
 * installation (and therefore which repositories) we may act on.
 */

const API = 'https://api.github.com';
const JWT_LIFETIME_SECONDS = 540;
const JWT_BACKDATE_SECONDS = 60;

export interface ConfiguredApp extends GithubAppConfig {
  appId: string;
  privateKeyPem: string;
}

/** Narrowing helper: throws a clear config error instead of a null deref. */
export function requireGithubApp(config: GithubAppConfig): ConfiguredApp {
  if (!config.enabled || !config.appId || !config.privateKeyPem) {
    throw new AppError(
      'CONFIG_ERROR',
      'GitHub App is not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_SLUG)',
      { status: 503 },
    );
  }
  return { ...config, appId: config.appId, privateKeyPem: config.privateKeyPem };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importAppKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(pem);
  if (cached) return cached;

  const created = importPKCS8(pem, 'RS256').catch((cause) => {
    keyCache.delete(pem);
    throw new AppError(
      'CONFIG_ERROR',
      'GITHUB_APP_PRIVATE_KEY is not a valid PKCS#8 RSA private key',
      { status: 503, cause },
    );
  });

  keyCache.set(pem, created);
  return created;
}

export async function createAppJwt(app: ConfiguredApp, nowMs = Date.now()): Promise<string> {
  const key = await importAppKey(app.privateKeyPem);
  const now = Math.floor(nowMs / 1000);

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(app.clientId ?? app.appId)
    .setIssuedAt(now - JWT_BACKDATE_SECONDS)
    .setExpirationTime(now + JWT_LIFETIME_SECONDS)
    .sign(key);
}

function mapGithubAppError(status: number, detail: string, context: string): AppError {
  if (status === 401) {
    return new AppError('GITHUB_AUTH_EXPIRED', 'GitHub rejected the App credentials', {
      cause: detail,
    });
  }
  if (status === 404) {
    return new AppError('GITHUB_NOT_FOUND', 'GitHub App installation not found', {
      cause: detail,
    });
  }
  if (status === 403 || status === 429) {
    return new AppError('GITHUB_FORBIDDEN', `GitHub rate-limited the App request (${context})`, {
      cause: detail,
      retryable: true,
    });
  }
  if (status === 422) {
    return new AppError('GITHUB_CONFLICT', `GitHub rejected the App request (${context})`, {
      cause: detail,
    });
  }
  return new AppError('GITHUB_UNAVAILABLE', `GitHub App request failed (${context})`, {
    cause: detail,
    retryable: status >= 500,
  });
}

async function appFetch(
  app: ConfiguredApp,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const jwt = await createAppJwt(app);
  let response: Response;

  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'user-agent': 'openmi-agent/0.1',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new AppError('GITHUB_UNAVAILABLE', 'GitHub App request failed', {
      cause,
      retryable: true,
    });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw mapGithubAppError(response.status, detail.slice(0, 300), path);
  }
  return response;
}

export interface AppInstallation {
  id: number;
  login: string;
  accountType: string | null;
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

/**
 * Reads an installation from GitHub. Always call this before trusting an
 * `installation_id` from a redirect: GitHub documents that the query parameter
 * can be spoofed, so the App must confirm it owns the installation.
 */
export async function getAppInstallation(
  app: ConfiguredApp,
  installationId: number,
): Promise<AppInstallation> {
  const response = await appFetch(app, `/app/installations/${installationId}`);
  const payload = (await response.json()) as {
    id?: number;
    account?: { login?: string; type?: string } | null;
    repository_selection?: string;
    suspended_at?: string | null;
  };

  if (typeof payload.id !== 'number' || !payload.account?.login) {
    throw new AppError('GITHUB_UNAVAILABLE', 'Malformed installation response from GitHub');
  }

  return {
    id: payload.id,
    login: payload.account.login,
    accountType: payload.account.type ?? null,
    repositorySelection: payload.repository_selection === 'all' ? 'all' : 'selected',
    suspended: Boolean(payload.suspended_at),
  };
}

export interface MintedInstallationToken {
  token: string;
  expiresAt: string;
}

/**
 * Mints a token for the installation with the permissions the installation
 * itself grants. Requesting a narrower permission set here would risk a 422 for
 * permissions the owner never approved.
 */
export async function mintInstallationToken(
  app: ConfiguredApp,
  installationId: number,
): Promise<MintedInstallationToken> {
  const response = await appFetch(app, `/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  const payload = (await response.json()) as { token?: string; expires_at?: string };
  if (!payload.token || !payload.expires_at) {
    throw new AppError('GITHUB_UNAVAILABLE', 'GitHub did not return an installation token');
  }

  return { token: payload.token, expiresAt: payload.expires_at };
}

/** Repositories visible to an installation token (not the user's full account). */
export async function listInstallationRepos(token: string): Promise<GithubRepoView[]> {
  const repos: GithubRepoView[] = [];

  for (let page = 1; page <= 3; page += 1) {
    let response: Response;
    try {
      response = await fetch(
        `${API}/installation/repositories?per_page=100&page=${page}`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'user-agent': 'openmi-agent/0.1',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch (cause) {
      throw new AppError('GITHUB_UNAVAILABLE', 'Could not list installation repositories', {
        cause,
        retryable: true,
      });
    }

    if (response.status === 401) {
      throw new AppError('GITHUB_AUTH_EXPIRED', 'Installation token was rejected');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw mapGithubAppError(response.status, detail.slice(0, 300), 'installation/repositories');
    }

    const payload = (await response.json()) as {
      total_count?: number;
      repositories?: Array<{
        full_name: string;
        name: string;
        owner?: { login?: string };
        private?: boolean;
        default_branch?: string;
        updated_at?: string | null;
        permissions?: { push?: boolean };
      }>;
    };

    const batch = payload.repositories ?? [];
    for (const repo of batch) {
      repos.push({
        fullName: repo.full_name,
        name: repo.name,
        owner: repo.owner?.login ?? repo.full_name.split('/')[0] ?? '',
        private: Boolean(repo.private),
        defaultBranch: repo.default_branch ?? 'main',
        canPush: repo.permissions?.push ?? true,
        updatedAt: repo.updated_at ?? null,
      });
    }

    if (batch.length < 100) break;
  }

  return repos;
}
