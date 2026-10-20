import { Hono } from 'hono';
import { z } from 'zod';
import type { CreateTaskResponse, QuotaView, TaskDetail } from '../../shared/types';
import type { AppEnv } from '../auth/middleware';
import { getProject } from '../db/projects';
import {
  addTaskEvent,
  createTask,
  failTask,
  getTaskForOwner,
  listProjectTasks,
  listTaskEvents,
  setWorkflowInstance,
  toTaskDetail,
  toTaskSummary,
} from '../db/tasks';
import { countActiveTasks, consumeTaskQuota, refundTaskQuota } from '../db/users';
import { hasGithubAuth } from '../github/auth';
import { loadConfig } from '../env';
import { AppError } from '../lib/errors';
import { readJson } from '../lib/http';
import { log } from '../lib/logger';
import { nextUtcMidnight } from '../lib/time';
import { background } from '../platform/background';
import { startTaskRun } from '../platform/dispatch';
import { recoverStaleTasks } from '../platform/recovery';

export const taskRoutes = new Hono<AppEnv>();

const createTaskSchema = z.object({
  projectId: z.uuid(),
  prompt: z.string().trim().min(4, 'Describe the change in at least a few words').max(4000),
});

/**
 * Accepts a prompt, reserves a daily slot, and hands the work to a durable
 * Workflow. The HTTP response never waits on the agent: the browser tab can be
 * closed the moment this returns.
 */
taskRoutes.post('/tasks', async (c) => {
  const user = c.var.user;
  const body = await readJson(c, createTaskSchema);
  const config = loadConfig(c.env);

  const project = await getProject(c.env, user.id, body.projectId);

  if (!(await hasGithubAuth(c.env, user.id))) {
    throw new AppError('GITHUB_NOT_CONNECTED', 'Connect GitHub before running a task');
  }

  const active = await countActiveTasks(c.env, user.id);
  if (active >= config.maxConcurrentTasks) {
    throw new AppError(
      'TOO_MANY_RUNNING_TASKS',
      `You already have ${active} task(s) running. Wait for one to finish.`,
    );
  }

  const quota = await consumeTaskQuota(c.env, user.id, config.dailyTaskLimit);
  if (!quota.allowed) {
    throw new AppError(
      'QUOTA_EXCEEDED',
      `Daily limit reached (${quota.limit} tasks). Resets at midnight UTC.`,
      { meta: { resetsAt: quota.resetsAt, limit: quota.limit } },
    );
  }

  // From here on, any failure must not silently keep the reserved slot.
  let taskId: string | null = null;
  try {
    const task = await createTask(c.env, {
      projectId: project.id,
      ownerId: user.id,
      prompt: body.prompt,
    });
    taskId = task.id;

    const dispatch = await startTaskRun(c.env, {
      taskId: task.id,
      userId: user.id,
      projectId: project.id,
    });
    if (dispatch.instanceId) {
      await setWorkflowInstance(c.env, task.id, dispatch.instanceId);
    }
    await addTaskEvent(c.env, task.id, 'Queued for the background agent');

    // Opportunistic recovery keeps the queue moving even on plans whose cron
    // only runs daily. Bounded so it never delays the response.
    background(recoverStaleTasks(c.env, { limit: 3 }), 'recovery-sweep');

    const response: CreateTaskResponse = {
      task: toTaskSummary({ ...task, status: 'queued' }),
      quota: {
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
        resetsAt: nextUtcMidnight(),
      } satisfies QuotaView,
    };

    c.header('cache-control', 'private, no-store');
    return c.json(response, 202);
  } catch (error) {
    await refundTaskQuota(c.env, user.id);
    if (taskId) {
      await failTask(c.env, taskId, {
        code: 'INTERNAL',
        message: 'Could not start the background agent. Your quota was refunded.',
      }).catch(() => undefined);
    }
    log.error('tasks.enqueue_failed', {
      message: error instanceof Error ? error.message : String(error),
      taskId,
    });
    throw new AppError(
      'INTERNAL',
      'Could not start the background agent. Your quota was refunded.',
      { retryable: true, cause: error },
    );
  }
});

taskRoutes.get('/tasks/:id', async (c) => {
  const taskId = c.req.param('id');
  if (!z.uuid().safeParse(taskId).success) {
    throw new AppError('BAD_REQUEST', 'Invalid task id');
  }

  const row = await getTaskForOwner(c.env, c.var.user.id, taskId);
  const events = await listTaskEvents(c.env, taskId);
  const detail: TaskDetail = toTaskDetail(row, events);

  c.header('cache-control', 'private, no-store');
  return c.json(detail);
});

taskRoutes.get('/projects/:id/tasks', async (c) => {
  const projectId = c.req.param('id');
  if (!z.uuid().safeParse(projectId).success) {
    throw new AppError('BAD_REQUEST', 'Invalid project id');
  }

  const project = await getProject(c.env, c.var.user.id, projectId);
  const tasks = await listProjectTasks(c.env, c.var.user.id, project.id);

  c.header('cache-control', 'private, no-store');
  return c.json({ tasks });
});
