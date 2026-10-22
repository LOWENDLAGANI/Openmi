import { env } from '../env.js';
import { AppError, DeadlineExceededError, refundsQuota } from '../errors.js';
import { octokitFor, resolveGithubAuth } from '../github/auth.js';
import { pinBase, atomicCommit, type PinnedBase } from '../github/commit.js';
import { selectContext, formatContext } from './context.js';
import { generatePatch } from './model.js';
import { patchSummary } from './policy.js';
import { runSteps, type Step } from './step-runner.js';
import {
  getTask,
  leaseTask,
  releaseLease,
  updateTask,
  appendEvent,
} from '../db/tasks.js';
import { getProject } from '../db/projects.js';
import { refundTaskQuota } from '../db/quota.js';
import type { Task, PatchSet } from '../../shared/types.js';

// The heart of the product. Idempotent: every stage re-reads the task doc and
// skips work already persisted. On deadline, releases lease and re-dispatches
// (handled by the caller). On our-failure, refunds quota.
export async function runTaskPipeline(taskId: string): Promise<void> {
  const budget = env.runBudgetSeconds();
  // Lease is slightly shorter than budget so a crashed invocation's lease
  // expires before we would ever re-dispatch on deadline.
  const task = await leaseTask(taskId, budget - 10);
  if (!task) return; // another invocation owns it, or it's terminal

  await appendEvent(taskId, { type: 'claimed', message: `runner claimed task (run #${task.runCount})` });

  try {
    await runSteps(
      [
        stepResolveBase(task),
        stepReadContext(task),
        stepGeneratePatch(task),
        stepCommit(task),
        stepFinalize(task),
      ],
      budget,
    );
  } catch (e) {
    if (e instanceof DeadlineExceededError) {
      await releaseLease(taskId);
      await appendEvent(taskId, { type: 'info', message: 'budget exceeded; handing off to fresh invocation' });
      throw e; // caller re-dispatches
    }
    await handleFailure(task, e);
  }
}

function stepResolveBase(task: Task): Step<PinnedBase> {
  return {
    name: 'resolve-base',
    run: async () => {
      const project = await getProject(task.projectId, task.ownerId);
      if (!project) throw new AppError('NOT_FOUND', 'project vanished');
      const auth = await resolveGithubAuth(task.ownerId);
      const octokit = octokitFor(auth.token);
      const pinned = await pinBase(octokit, project.repoFullName, project.defaultBranch);
      await updateTask(task.id, {
        baseSha: pinned.baseSha,
        baseTreeSha: pinned.baseTreeSha,
        branch: pinned.branch,
      });
      await appendEvent(task.id, { type: 'base_pinned', message: `pinned ${pinned.branch}@${pinned.baseSha.slice(0, 7)} (${pinned.tree.length} files)` });
      return pinned;
    },
  };
}

function stepReadContext(task: Task): Step<string> {
  return {
    name: 'read-context',
    run: async () => {
      const current = (await getTask(task.id))!;
      if (current.patch) return ''; // already have a patch; skip
      const project = await getProject(task.projectId, task.ownerId);
      if (!project) throw new AppError('NOT_FOUND', 'project vanished');
      const auth = await resolveGithubAuth(task.ownerId);
      const octokit = octokitFor(auth.token);
      const pinned = await pinBase(octokit, project.repoFullName, project.defaultBranch);
      const files = await selectContext(octokit, pinned.owner, pinned.repo, pinned.tree, task.prompt);
      await appendEvent(task.id, { type: 'context_read', message: `${files.length} context file(s) selected` });
      return formatContext(files);
    },
  };
}

function stepGeneratePatch(task: Task): Step<PatchSet> {
  return {
    name: 'generate-patch',
    run: async (_ctx) => {
      const current = (await getTask(task.id))!;
      if (current.patch) return current.patch;
      const project = await getProject(task.projectId, task.ownerId);
      if (!project) throw new AppError('NOT_FOUND', 'project vanished');
      const auth = await resolveGithubAuth(task.ownerId);
      const octokit = octokitFor(auth.token);
      const pinned = await pinBase(octokit, project.repoFullName, project.defaultBranch);
      const files = await selectContext(octokit, pinned.owner, pinned.repo, pinned.tree, task.prompt);
      const context = formatContext(files);
      const result = await generatePatch(task.prompt, project.repoFullName, context);
      await updateTask(task.id, { patch: result.patch, tokenUsage: result.usage });
      await appendEvent(task.id, {
        type: 'patch_generated',
        message: patchSummary(result.patch),
        data: {
          tokens: result.usage.total,
          ...(result.attempts.length > 1 ? { attempts: result.attempts } : {}),
        },
      });
      return result.patch;
    },
  };
}

function stepCommit(task: Task): Step<{ commitSha: string; commitUrl: string; pullRequestUrl?: string }> {
  return {
    name: 'commit',
    run: async () => {
      const current = (await getTask(task.id))!;
      if (current.commitSha) {
        return { commitSha: current.commitSha, commitUrl: current.commitUrl!, pullRequestUrl: current.pullRequestUrl };
      }
      if (!current.patch) throw new AppError('INTERNAL', 'commit step reached without a patch');
      const project = await getProject(task.projectId, task.ownerId);
      if (!project) throw new AppError('NOT_FOUND', 'project vanished');
      const auth = await resolveGithubAuth(task.ownerId);
      const octokit = octokitFor(auth.token);
      const pinned = await pinBase(octokit, project.repoFullName, project.defaultBranch);
      const message = `openmi: ${current.patch.summary || task.prompt.slice(0, 60)}\n\nprompt: ${task.prompt}`;
      const result = await atomicCommit(octokit, pinned, current.patch, message, current.commitMode);
      await updateTask(task.id, {
        commitSha: result.commitSha,
        commitUrl: result.commitUrl,
        pullRequestUrl: result.pullRequestUrl,
        branch: result.branch,
      });
      await appendEvent(task.id, {
        type: 'committed',
        message: `committed ${result.commitSha.slice(0, 7)} to ${result.branch}`,
        data: { commitUrl: result.commitUrl, pullRequestUrl: result.pullRequestUrl },
      });
      return result;
    },
  };
}

function stepFinalize(task: Task): Step<void> {
  return {
    name: 'finalize',
    run: async () => {
      await updateTask(task.id, { status: 'succeeded' });
      await appendEvent(task.id, { type: 'succeeded', message: 'task completed' });
    },
  };
}

async function handleFailure(task: Task, e: unknown): Promise<void> {
  const code = e instanceof AppError ? e.code : 'INTERNAL';
  const message = e instanceof Error ? e.message : String(e);
  const issues = e instanceof AppError ? e.issues : [];
  const current = (await getTask(task.id))!;
  // A task that already committed is never marked failed.
  if (current.commitSha) {
    await appendEvent(task.id, { type: 'info', message: `post-commit error (ignored): ${message}` });
    return;
  }
  const status = code === 'GITHUB_CONFLICT' ? 'conflict' : 'failed';
  await updateTask(task.id, {
    status,
    errorCode: code,
    errorMessage: message,
    ...(issues.length ? { errorIssues: issues } : {}),
  });
  await appendEvent(task.id, {
    type: status === 'conflict' ? 'conflict' : 'failed',
    message,
    ...(issues.length ? { data: { issues } } : {}),
  });
  if (issues.length > 1) {
    await appendEvent(task.id, {
      type: 'info',
      message: `${issues.length} problems found: ${issues.map((i) => i.message).join('; ')}`,
    });
  }
  if (refundsQuota(code)) {
    await refundTaskQuota(task.ownerId);
    await appendEvent(task.id, { type: 'info', message: 'quota refunded (system-caused failure)' });
  }
}
