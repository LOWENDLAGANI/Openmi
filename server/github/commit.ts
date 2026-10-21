import type { Octokit } from '@octokit/rest';
import type { PatchSet, CommitMode } from '../../shared/types.js';
import { AppError } from '../errors.js';
import { assertPatchTargets, assertSuperset, type TreeEntry } from './policy.js';

export interface PinnedBase {
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  baseTreeSha: string;
  tree: TreeEntry[];
  snapshotShas: Map<string, string>;
  truncated: boolean;
}

// Step 1: pin the base commit + recursive tree. Idempotent — stored on the task.
export async function pinBase(
  octokit: Octokit,
  repoFullName: string,
  branch: string,
): Promise<PinnedBase> {
  const [owner, repo] = repoFullName.split('/');
  const { data: ref } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const baseSha = ref.object.sha;
  const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: baseSha });
  const baseTreeSha = commit.tree.sha;
  const { data: treeData } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: baseTreeSha,
    recursive: '1',
  });
  const truncated = !!treeData.truncated;
  const tree: TreeEntry[] = (treeData.tree as any[])
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, sha: e.sha, type: 'blob', size: e.size }));
  const snapshotShas = new Map(tree.map((e) => [e.path, e.sha]));
  return { owner, repo, branch, baseSha, baseTreeSha, tree, snapshotShas, truncated };
}

// Step 2: one atomic commit. Re-reads base, asserts targets, creates blobs,
// builds tree with base_tree, asserts superset, creates commit, fast-forward
// ref update (force:false). Returns commit sha + url.
export async function atomicCommit(
  octokit: Octokit,
  pinned: PinnedBase,
  patch: PatchSet,
  message: string,
  mode: CommitMode,
): Promise<{ commitSha: string; commitUrl: string; pullRequestUrl?: string; branch: string }> {
  const { owner, repo, branch, baseSha, baseTreeSha, tree } = pinned;

  // Re-fetch current head to detect concurrent moves.
  const { data: refNow } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  if (refNow.object.sha !== baseSha) {
    throw new AppError('GITHUB_CONFLICT', 'branch moved since base was pinned');
  }

  // Reconcile targets against the real tree (snapshot shas catch human edits).
  assertPatchTargets(patch, tree, pinned.snapshotShas);

  // Create blobs (never mutate existing blobs).
  const treeEntries = [];
  for (const f of patch.files) {
    const { data: blob } = await octokit.git.createBlob({
      owner,
      repo,
      content: Buffer.from(f.content, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // Build new tree with base_tree — GitHub retains everything we did not name.
  const { data: newTree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: treeEntries as any,
  });

  // Superset assertion before any commit object exists.
  if (!pinned.truncated) {
    const { data: verifyTree } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: newTree.sha,
      recursive: '1',
    });
    const newEntries: TreeEntry[] = (verifyTree.tree as any[])
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, sha: e.sha, type: 'blob' }));
    assertSuperset(tree, newEntries);
  }

  let targetBranch = branch;
  if (mode === 'pull_request') {
    targetBranch = `openmi/task-${Date.now().toString(36)}`;
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${targetBranch}`,
      sha: baseSha,
    });
  }

  const { data: newCommit } = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [baseSha],
  });

  // Fast-forward-only ref update. GitHub rejects non-fast-forward regardless.
  try {
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${targetBranch}`,
      sha: newCommit.sha,
      force: false,
    });
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status;
    if (status === 422) {
      throw new AppError('GITHUB_CONFLICT', 'ref update rejected (non-fast-forward)');
    }
    throw e;
  }

  let pullRequestUrl: string | undefined;
  if (mode === 'pull_request') {
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title: message.split('\n')[0],
      head: targetBranch,
      base: branch,
      body: patch.summary ?? 'OpenMi generated change.',
    });
    pullRequestUrl = pr.html_url;
  }

  return {
    commitSha: newCommit.sha,
    commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
    pullRequestUrl,
    branch: targetBranch,
  };
}
