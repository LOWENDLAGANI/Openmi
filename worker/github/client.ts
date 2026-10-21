import { Octokit } from '@octokit/rest';
import { AppError } from '../lib/errors.js';

/**
 * Octokit is fetch-based, so it runs unchanged on Workers. Requests are
 * time-boxed to keep a hung GitHub call from burning workflow wall-clock time.
 */
export function createOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: 'openmi-agent/0.1',
    request: {
      timeout: 20_000,
      fetch: globalThis.fetch.bind(globalThis),
    },
  });
}

interface GithubHttpError {
  status?: number;
  message?: string;
  response?: { headers?: Record<string, string> };
}

/** Maps GitHub transport/HTTP failures onto the app's typed error taxonomy. */
export function mapGithubError(error: unknown, context: string): AppError {
  if (error instanceof AppError) return error;

  const httpError = error as GithubHttpError;
  const status = httpError.status;
  const detail = httpError.message ?? 'GitHub request failed';
  const remaining = httpError.response?.headers?.['x-ratelimit-remaining'];

  if (status === 401) {
    return new AppError('GITHUB_AUTH_EXPIRED', 'GitHub access expired; reconnect GitHub', {
      cause: error,
    });
  }
  if (status === 403 || status === 429) {
    const rateLimited = remaining === '0';
    return new AppError(
      'GITHUB_FORBIDDEN',
      rateLimited
        ? 'GitHub API rate limit reached; retry shortly'
        : 'GitHub denied this action (missing repo permission)',
      { cause: error, retryable: rateLimited },
    );
  }
  if (status === 404) {
    return new AppError('GITHUB_NOT_FOUND', 'Repository or ref not found on GitHub', {
      cause: error,
    });
  }
  if (status === 409 || status === 422) {
    return new AppError('GITHUB_CONFLICT', 'Branch moved while committing; retry the task', {
      cause: error,
    });
  }
  return new AppError('GITHUB_UNAVAILABLE', `GitHub request failed (${context})`, {
    cause: error,
    retryable: true,
  });
}

export interface RepoCoordinates {
  owner: string;
  repo: string;
  fullName: string;
}

export function parseRepoFullName(fullName: string): RepoCoordinates {
  const trimmed = fullName.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError('BAD_REQUEST', 'Repository must be in "owner/name" form');
  }
  const [owner, repo] = parts as [string, string];
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!valid.test(owner) || !valid.test(repo)) {
    throw new AppError('BAD_REQUEST', 'Repository name contains unsupported characters');
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}
