import type { Octokit } from '@octokit/rest';
import type { GithubRepoView } from '../../shared/types.js';
import { AppError } from '../lib/errors.js';
import { createOctokit, mapGithubError, parseRepoFullName } from './client.js';

/** Files larger than this are never sent to the model. */
export const MAX_CONTEXT_FILE_BYTES = 48 * 1024;

export interface RepoInfo {
  fullName: string;
  defaultBranch: string;
  canPush: boolean;
  private: boolean;
}

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

export interface RepoTree {
  entries: TreeEntry[];
  truncated: boolean;
}

export async function getAuthenticatedLogin(
  octokit: Octokit,
): Promise<{ login: string; scopes: string[] }> {
  try {
    const response = await octokit.rest.users.getAuthenticated();
    const rawScopes = response.headers['x-oauth-scopes'];
    const scopes =
      typeof rawScopes === 'string'
        ? rawScopes
            .split(',')
            .map((scope) => scope.trim())
            .filter(Boolean)
        : [];
    return { login: response.data.login, scopes };
  } catch (error) {
    throw mapGithubError(error, 'users.getAuthenticated');
  }
}

export async function listUserRepos(token: string): Promise<GithubRepoView[]> {
  const octokit = createOctokit(token);
  try {
    const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      per_page: 100,
      sort: 'updated',
      affiliation: 'owner,collaborator,organization_member',
    });

    return repos.slice(0, 300).map((repo) => ({
      fullName: repo.full_name,
      name: repo.name,
      owner: repo.owner?.login ?? repo.full_name.split('/')[0] ?? '',
      private: Boolean(repo.private),
      defaultBranch: repo.default_branch ?? 'main',
      canPush: Boolean(repo.permissions?.push),
      updatedAt: repo.updated_at ?? null,
    }));
  } catch (error) {
    throw mapGithubError(error, 'repos.listForAuthenticatedUser');
  }
}

export async function getRepoInfo(token: string, repoFullName: string): Promise<RepoInfo> {
  const { owner, repo, fullName } = parseRepoFullName(repoFullName);
  const octokit = createOctokit(token);
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      canPush: Boolean(data.permissions?.push),
      private: Boolean(data.private),
    };
  } catch (error) {
    throw mapGithubError(error, 'repos.get');
  }
}

export async function getBranchHead(
  octokit: Octokit,
  repoFullName: string,
  branch: string,
): Promise<string> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  try {
    const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  } catch (error) {
    throw mapGithubError(error, 'repos.getBranch');
  }
}

export async function getCommitTreeSha(
  octokit: Octokit,
  repoFullName: string,
  commitSha: string,
): Promise<string> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  try {
    const { data } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
    return data.tree.sha;
  } catch (error) {
    throw mapGithubError(error, 'git.getCommit');
  }
}

export async function getRepoTree(
  octokit: Octokit,
  repoFullName: string,
  treeSha: string,
): Promise<RepoTree> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  try {
    const { data } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: treeSha,
      recursive: 'true',
    });

    const entries = (data.tree ?? []).flatMap((node): TreeEntry[] => {
      if (node.type !== 'blob' || !node.path || !node.sha) return [];
      return [{ path: node.path, sha: node.sha, size: node.size ?? 0 }];
    });

    return { entries, truncated: Boolean(data.truncated) };
  } catch (error) {
    throw mapGithubError(error, 'git.getTree');
  }
}

export async function getBlobText(
  octokit: Octokit,
  repoFullName: string,
  blobSha: string,
): Promise<string> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  try {
    const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: blobSha });
    const encoding = (data as { encoding?: string }).encoding;
    if (encoding !== 'base64') {
      throw new AppError('GITHUB_UNAVAILABLE', 'Unexpected blob encoding from GitHub');
    }
    const binary = atob((data.content ?? '').replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch (error) {
    throw mapGithubError(error, 'git.getBlob');
  }
}

export async function createBlob(
  octokit: Octokit,
  repoFullName: string,
  content: string,
): Promise<string> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  try {
    const { data } = await octokit.rest.git.createBlob({
      owner,
      repo,
      content,
      encoding: 'utf-8',
    });
    return data.sha;
  } catch (error) {
    throw mapGithubError(error, 'git.createBlob');
  }
}
