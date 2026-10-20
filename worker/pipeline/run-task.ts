import type { Env } from '../env';
import type { ErrorCode } from '../lib/errors';
import { AppError, REFUNDABLE_CODES, isAppError } from '../lib/errors';
import { log } from '../lib/logger';
import {
  addTaskEvent,
  completeTask,
  failTask,
  getTaskRow,
  leaseTask,
  saveTaskPatch,
  setTaskBase,
} from '../db/tasks';
import { getProject } from '../db/projects';
import { refundTaskQuota } from '../db/users';
import { createOctokit } from '../github/client';
import { getBranchHead, getBlobText, getCommitTreeSha, getRepoTree } from '../github/repo';
import { commitPatchSet } from '../github/commit';
import { resolveGithubAuth, hasGithubAuth } from '../github/auth';
import { generatePatch } from '../agent/generate';
import { selectContextFiles, truncateFileContent } from '../agent/context';
import { isDeadlineExceeded } from './step-runner';
import type { StepRunner } from './step-runner';
import type {
  ContextFile,
  PatchFile,
  RepoContext,
  TaskWorkflowParams,
} from '../workflows/types';

export interface PipelineResult {
  ok: boolean;
  skipped?: boolean;
  commitSha?: string;
}

const LEASE_MS = 10 * 60 * 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function parseStoredPatch(patch: unknown): { summary: string; files: PatchFile[] } {
  const record = patch as { summary?: unknown; files?: unknown } | null;
  if (!record || typeof record.summary !== 'string' || !Array.isArray(record.files)) {
    throw new AppError('INTERNAL', 'Stored patch set is missing or malformed');
  }
  return { summary: record.summary, files: record.files as PatchFile[] };
}

export function classifyFailure(error: unknown): { code: string; message: string } {
  if (isAppError(error)) return { code: error.code, message: error.message };

  const raw = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z_]{2,40}):\s*(.+)$/s.exec(raw);
  if (match?.[1] && match[2]) return { code: match[1], message: match[2] };
  return { code: 'INTERNAL', message: raw.slice(0, 500) || 'Task failed' };
}

/**
 * The durable task pipeline.
 *
 * Every stage re-reads the task row and skips work that is already persisted
 * (pinned base, stored patch, recorded commit). That single property gives both
 * Cloudflare Workflow replays and serverless re-dispatches the same guarantee:
 * resuming never repeats a side effect, and a task is never committed twice.
 */
export async function runTaskPipeline(
  env: Env,
  params: TaskWorkflowParams,
  runner: StepRunner,
): Promise<PipelineResult> {
  const { taskId, userId, projectId } = params;

  try {
    const claim = await runner.run(
      'claim task',
      async () => {
        const { row, claimed } = await leaseTask(env, taskId, LEASE_MS);
        if (!claimed) return { owned: false as const, done: false };
        if (row.status === 'succeeded' || row.status === 'failed') {
          return { owned: false as const, done: true };
        }
        if (!(await hasGithubAuth(env, userId))) {
          throw new AppError('GITHUB_NOT_CONNECTED', 'Connect GitHub to run tasks');
        }
        if (!row.started_at) await addTaskEvent(env, taskId, 'Agent picked up the task');
        return { owned: true as const, done: false, prompt: row.prompt };
      },
      { retries: 2, timeoutMs: 60_000 },
    );

    if (!claim.owned) {
      log.info('pipeline.not_owned', { taskId, done: claim.done });
      return { skipped: true, ok: claim.done };
    }

    const prompt = claim.prompt;

    // Pin an immutable base commit: every later comparison is against this.
    const base = await runner.run(
      'resolve base commit',
      async () => {
        const row = await getTaskRow(env, taskId);
        const project = await getProject(env, userId, projectId);
        const { token } = await resolveGithubAuth(env, userId);
        const octokit = createOctokit(token);

        if (row.base_commit_sha && row.base_branch) {
          const treeSha = await getCommitTreeSha(
            octokit,
            project.repo_full_name,
            row.base_commit_sha,
          );
          return {
            repoFullName: project.repo_full_name,
            branch: row.base_branch,
            baseSha: row.base_commit_sha,
            treeSha,
            resumed: true,
          };
        }

        const baseSha = await getBranchHead(
          octokit,
          project.repo_full_name,
          project.default_branch,
        );
        const treeSha = await getCommitTreeSha(octokit, project.repo_full_name, baseSha);
        await setTaskBase(env, taskId, {
          baseBranch: project.default_branch,
          baseCommitSha: baseSha,
        });
        await addTaskEvent(
          env,
          taskId,
          `Pinned ${project.repo_full_name}@${project.default_branch} at ${baseSha.slice(0, 7)}`,
        );

        return {
          repoFullName: project.repo_full_name,
          branch: project.default_branch,
          baseSha,
          treeSha,
          resumed: false,
        };
      },
      { retries: 3, timeoutMs: 120_000 },
    );

    // Read a token-budgeted slice of the repo for the model.
    const context = await runner.run<RepoContext>(
      'read repository context',
      async () => {
        const { token } = await resolveGithubAuth(env, userId);
        const octokit = createOctokit(token);
        const tree = await getRepoTree(octokit, base.repoFullName, base.treeSha);
        const selection = selectContextFiles(tree.entries, prompt);

        const files: ContextFile[] = [];
        let charBudgetUsed = 0;
        for (const batch of chunk(selection.entries, 6)) {
          const loaded = await Promise.all(
            batch.map(async (entry) => {
              const raw = await getBlobText(octokit, base.repoFullName, entry.sha);
              const truncated = truncateFileContent(raw);
              return {
                path: entry.path,
                sha: entry.sha,
                content: truncated.content,
                truncated: truncated.truncated,
              } satisfies ContextFile;
            }),
          );
          for (const file of loaded) {
            charBudgetUsed += file.content.length;
            files.push(file);
          }
        }

        if (!base.resumed) {
          await addTaskEvent(
            env,
            taskId,
            `Read ${files.length} file(s) from ${tree.entries.length} in the repo`,
          );
        }

        return {
          snapshot: {
            repoFullName: base.repoFullName,
            owner: base.repoFullName.split('/')[0] ?? '',
            repo: base.repoFullName.split('/')[1] ?? '',
            branch: base.branch,
            baseSha: base.baseSha,
            baseTreeSha: base.treeSha,
            fileCount: tree.entries.length,
            treeTruncated: tree.truncated,
          },
          treePaths: tree.entries.slice(0, 800).map((entry) => entry.path),
          files,
          omittedFiles: selection.omitted,
          charBudgetUsed,
        };
      },
      { retries: 2, timeoutMs: 180_000 },
    );

    // Model call. The full file contents stay in Postgres, not in step state.
    const patchStage = await runner.run(
      'generate patch set',
      async () => {
        const row = await getTaskRow(env, taskId);
        if (row.patch) {
          return {
            summary: row.summary ?? '',
            filesChanged: row.files_changed,
            model: row.model ?? '',
            resumed: true,
          };
        }

        const { token } = await resolveGithubAuth(env, userId);
        const octokit = createOctokit(token);
        // Fresh tree read for path policy: validate against reality, not the prompt.
        const tree = await getRepoTree(octokit, base.repoFullName, base.treeSha);

        const patch = await generatePatch(env, { prompt, context, tree: tree.entries });

        await saveTaskPatch(env, taskId, {
          patch,
          summary: patch.summary,
          model: patch.model,
          filesChanged: patch.files.length,
          promptTokens: patch.promptTokens,
          completionTokens: patch.completionTokens,
        });
        await addTaskEvent(env, taskId, `Model proposed ${patch.files.length} file change(s)`);

        return {
          summary: patch.summary,
          filesChanged: patch.files.length,
          model: patch.model,
          resumed: false,
        };
      },
      { retries: 1, timeoutMs: 360_000 },
    );

    // One atomic, non-forced commit.
    const commit = await runner.run(
      'commit to github',
      async () => {
        const row = await getTaskRow(env, taskId);
        if (row.commit_sha && row.commit_url && row.branch) {
          // Replay or re-dispatch after a successful commit: never commit twice.
          return {
            commitSha: row.commit_sha,
            branch: row.branch,
            filesChanged: row.files_changed,
            resumed: true,
          };
        }
        if (!row.patch) throw new AppError('INTERNAL', 'No patch set to commit');

        const stored = parseStoredPatch(row.patch);
        const project = await getProject(env, userId, projectId);
        const { token } = await resolveGithubAuth(env, userId);

        const result = await commitPatchSet({
          token,
          repoFullName: project.repo_full_name,
          baseSha: base.baseSha,
          branch: base.branch,
          files: stored.files,
          mode: project.commit_mode,
          taskId,
          summary: stored.summary || patchStage.summary,
          prompt,
        });

        await completeTask(env, taskId, {
          commitSha: result.commitSha,
          commitUrl: result.pullRequestUrl ?? result.commitUrl,
          branch: result.branch,
          filesChanged: result.filesChanged,
        });

        return {
          commitSha: result.commitSha,
          branch: result.branch,
          filesChanged: result.filesChanged,
          resumed: false,
        };
      },
      { retries: 1, timeoutMs: 240_000 },
    );

    await runner.run('finalize task', async () => {
      if (!commit.resumed) {
        await addTaskEvent(
          env,
          taskId,
          `Committed ${commit.commitSha.slice(0, 7)} to ${commit.branch} (${commit.filesChanged} file${commit.filesChanged === 1 ? '' : 's'})`,
        );
      }
      return true;
    });

    return { ok: true, commitSha: commit.commitSha };
  } catch (error) {
    // Out of time, not out of luck: leave the task running for re-dispatch.
    if (isDeadlineExceeded(error)) throw error;

    const failure = classifyFailure(error);

    try {
      await runner.run(
        'record failure',
        async () => {
          const row = await getTaskRow(env, taskId);
          if (row.status === 'succeeded' || row.commit_sha) return true;

          await failTask(env, taskId, { code: failure.code, message: failure.message });
          await addTaskEvent(env, taskId, failure.message, 'error');

          if (REFUNDABLE_CODES.has(failure.code as ErrorCode)) {
            await refundTaskQuota(env, userId);
            await addTaskEvent(env, taskId, 'Daily quota refunded (failure was ours)', 'warn');
          }
          return true;
        },
        { retries: 3, timeoutMs: 60_000 },
      );
    } catch (recordError) {
      log.error('pipeline.record_failure_failed', {
        taskId,
        message: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }

    log.error('pipeline.failed', { taskId, code: failure.code, message: failure.message });
    throw error;
  }
}
