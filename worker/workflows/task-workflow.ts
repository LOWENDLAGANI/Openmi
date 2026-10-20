import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../env';
import type { ErrorCode } from '../lib/errors';
import { REFUNDABLE_CODES, isAppError } from '../lib/errors';
import { log } from '../lib/logger';
import { addTaskEvent, claimTask, completeTask, failTask, getTaskRow, saveTaskPatch } from '../db/tasks';
import { getProject } from '../db/projects';
import { getGithubCredential, refundTaskQuota } from '../db/users';
import { createOctokit } from '../github/client';
import { getBranchHead, getCommitTreeSha, getBlobText, getRepoTree } from '../github/repo';
import { commitPatchSet } from '../github/commit';
import { resolveGithubAuth } from '../github/auth';
import { generatePatch } from '../agent/generate';
import { selectContextFiles, truncateFileContent } from '../agent/context';
import type {
  ContextFile,
  PatchFile,
  RepoContext,
  TaskWorkflowParams,
} from './types';

/** Steps fail fast on policy/business errors; transient faults use the retry config. */
class TaskFailure extends NonRetryableError {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'TaskFailure';
  }
}

function failFast(error: unknown): never {
  if (isAppError(error) && !error.retryable) throw new TaskFailure(error.code, error.message);
  throw error;
}

function classifyFailure(error: unknown): { code: string; message: string } {
  if (error instanceof TaskFailure) return { code: error.code, message: error.message };
  if (isAppError(error)) return { code: error.code, message: error.message };

  const raw = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z_]{2,40}):\s*(.+)$/s.exec(raw);
  if (match?.[1] && match[2]) return { code: match[1], message: match[2] };
  return { code: 'INTERNAL', message: raw.slice(0, 500) || 'Task failed' };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseStoredPatch(patch: unknown): { summary: string; files: PatchFile[] } {
  const record = patch as { summary?: unknown; files?: unknown } | null;
  if (!record || typeof record.summary !== 'string' || !Array.isArray(record.files)) {
    throw new TaskFailure('INTERNAL', 'Stored patch set is missing or malformed');
  }
  return { summary: record.summary, files: record.files as PatchFile[] };
}

/**
 * OpenMi's durable task pipeline.
 *
 * Every unit of work is a `step`, so the instance survives the user closing the
 * tab, switching carriers, or losing signal. Steps are replayed from their
 * persisted return values, and every side-effecting step re-checks the task row
 * first, making retries idempotent.
 */
export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<TaskWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const { taskId, userId, projectId } = event.payload;
    const env = this.env;

    try {
      const claim = await step.do(
        'claim task',
        { retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' },
        async () => {
          const row = await claimTask(env, taskId);
          if (row.status === 'succeeded' || row.status === 'failed') {
            return { skip: true as const };
          }
          const credential = await getGithubCredential(env, userId);
          if (!credential) {
            throw new TaskFailure('GITHUB_NOT_CONNECTED', 'Connect GitHub to run tasks');
          }
          await addTaskEvent(env, taskId, 'Agent picked up the task');
          return { skip: false as const, prompt: row.prompt };
        },
      );

      if (claim.skip) {
        log.info('workflow.skipped', { taskId });
        return { skipped: true };
      }

      const prompt = claim.prompt;

      // Pin an immutable base commit: every later comparison is against this.
      const base = await step.do(
        'resolve base commit',
        { retries: { limit: 3, delay: '3 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
        async () => {
          try {
            const project = await getProject(env, userId, projectId);
            const { token } = await resolveGithubAuth(env, userId);
            const octokit = createOctokit(token);
            const baseSha = await getBranchHead(
              octokit,
              project.repo_full_name,
              project.default_branch,
            );
            const treeSha = await getCommitTreeSha(octokit, project.repo_full_name, baseSha);

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
              commitMode: project.commit_mode,
            };
          } catch (error) {
            failFast(error);
          }
        },
      );

      // Read a token-budgeted slice of the repo for the model.
      const context = await step.do(
        'read repository context',
        { retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' }, timeout: '3 minutes' },
        async (): Promise<RepoContext> => {
          try {
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

            await addTaskEvent(
              env,
              taskId,
              `Read ${files.length} file(s) from ${tree.entries.length} in the repo`,
            );

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
              // Paths are capped so this step's persisted state stays small.
              treePaths: tree.entries.slice(0, 800).map((entry) => entry.path),
              files,
              omittedFiles: selection.omitted,
              charBudgetUsed,
            };
          } catch (error) {
            failFast(error);
          }
        },
      );

      // Model call. The full file contents stay in Postgres, not in step state.
      const generated = await step.do(
        'generate patch set',
        { retries: { limit: 1, delay: '5 seconds', backoff: 'exponential' }, timeout: '6 minutes' },
        async () => {
          try {
            const { token } = await resolveGithubAuth(env, userId);
            const octokit = createOctokit(token);
            // Fresh tree read for path policy: we validate against reality, not the prompt.
            const tree = await getRepoTree(octokit, base.repoFullName, base.treeSha);

            const patch = await generatePatch(env, {
              prompt,
              context,
              tree: tree.entries,
            });

            await saveTaskPatch(env, taskId, {
              patch,
              summary: patch.summary,
              model: patch.model,
              filesChanged: patch.files.length,
              promptTokens: patch.promptTokens,
              completionTokens: patch.completionTokens,
            });
            await addTaskEvent(
              env,
              taskId,
              `Model proposed ${patch.files.length} file change(s)`,
            );

            return {
              summary: patch.summary,
              filesChanged: patch.files.length,
              model: patch.model,
            };
          } catch (error) {
            failFast(error);
          }
        },
      );

      // One atomic, non-forced commit.
      const commit = await step.do(
        'commit to github',
        { retries: { limit: 1, delay: '10 seconds', backoff: 'exponential' }, timeout: '4 minutes' },
        async () => {
          try {
            const row = await getTaskRow(env, taskId);
            if (row.commit_sha && row.commit_url && row.branch) {
              // Replay after a successful commit: never commit twice.
              return {
                commitSha: row.commit_sha,
                commitUrl: row.commit_url,
                branch: row.branch,
                filesChanged: row.files_changed,
              };
            }
            if (!row.patch) throw new TaskFailure('INTERNAL', 'No patch set to commit');

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
              summary: stored.summary || generated.summary,
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
              commitUrl: result.commitUrl,
              branch: result.branch,
              filesChanged: result.filesChanged,
            };
          } catch (error) {
            failFast(error);
          }
        },
      );

      await step.do('finalize task', async () => {
        await addTaskEvent(
          env,
          taskId,
          `Committed ${commit.commitSha.slice(0, 7)} to ${commit.branch} (${commit.filesChanged} file${commit.filesChanged === 1 ? '' : 's'})`,
        );
        return true;
      });

      return { ok: true, commitSha: commit.commitSha };
    } catch (error) {
      const failure = classifyFailure(error);

      try {
        await step.do(
          'record failure',
          { retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' },
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
        );
      } catch (recordError) {
        log.error('workflow.record_failure_failed', {
          taskId,
          message: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }

      log.error('workflow.failed', { taskId, code: failure.code, message: failure.message });
      // Re-throw so the instance is marked errored and visible in analytics.
      throw error;
    }
  }
}
