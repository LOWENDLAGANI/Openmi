import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth/middleware';
import { requeueTask } from '../db/tasks';
import { AppError } from '../lib/errors';
import { readJson } from '../lib/http';
import { log } from '../lib/logger';
import { constantTimeEqual } from '../lib/timing';
import { runTaskPipeline } from '../pipeline/run-task';
import { createInlineStepRunner, isDeadlineExceeded } from '../pipeline/step-runner';
import { background } from '../platform/background';
import { startTaskRun } from '../platform/dispatch';
import { recoverStaleTasks } from '../platform/recovery';
import type { Env } from '../env';
import type { TaskWorkflowParams } from '../workflows/types';

/**
 * Runner endpoints for platforms without a Workflow engine (Vercel, Node).
 *
 * Both are public routes with their own authentication: the runner requires the
 * internal task token, and the cron endpoint requires the platform's cron
 * secret. Neither accepts a user session.
 */
export const internalRoutes = new Hono<AppEnv>();

const paramsSchema = z.object({
  taskId: z.uuid(),
  userId: z.uuid(),
  projectId: z.uuid(),
});

function runBudgetMs(env: Env): number {
  const seconds = Number.parseInt(env.RUN_BUDGET_SECONDS ?? '240', 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 240) * 1000;
}

function assertInternalToken(env: Env, header: string | undefined): void {
  const token = env.INTERNAL_TASK_TOKEN;
  if (!token) {
    throw new AppError('CONFIG_ERROR', 'INTERNAL_TASK_TOKEN is not configured', { status: 503 });
  }
  if (!header || !constantTimeEqual(header, token)) {
    throw new AppError('UNAUTHENTICATED', 'Invalid internal token');
  }
}

/**
 * Vercel-style dispatch target. Responds 202 immediately, then runs the
 * pipeline inside `waitUntil` so the caller is never blocked by a cold start.
 * If the invocation runs out of time, the task's lease is released and a fresh
 * invocation continues from persisted state.
 */
internalRoutes.post('/internal/run-task', async (c) => {
  assertInternalToken(c.env, c.req.header('x-openmi-internal'));
  const params: TaskWorkflowParams = await readJson(c, paramsSchema);

  background(runDispatchedTask(c.env, params), 'run-task');
  return c.json({ accepted: true }, 202);
});

async function runDispatchedTask(env: Env, params: TaskWorkflowParams): Promise<void> {
  const runner = createInlineStepRunner(Date.now() + runBudgetMs(env));

  try {
    await runTaskPipeline(env, params, runner);
  } catch (error) {
    if (!isDeadlineExceeded(error)) throw error;

    log.warn('pipeline.deadline_reached', { taskId: params.taskId });
    await requeueTask(env, params.taskId);
    // Hand the remainder to a fresh invocation with a fresh time budget.
    await startTaskRun(env, params, { await: true });
  }
}

/**
 * Recovery sweep. Cron is best-effort on every serverless platform, so this is
 * also called opportunistically when a new task is accepted.
 */
internalRoutes.get('/cron/recover', async (c) => {
  const secret = c.env.CRON_SECRET;
  if (!secret) {
    throw new AppError('CONFIG_ERROR', 'CRON_SECRET is not configured', { status: 503 });
  }

  const authorization = c.req.header('authorization') ?? '';
  if (!constantTimeEqual(authorization, `Bearer ${secret}`)) {
    throw new AppError('UNAUTHENTICATED', 'Invalid cron credentials');
  }

  const limitParam = Number.parseInt(c.req.query('limit') ?? '10', 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 25) : 10;
  const recovered = await recoverStaleTasks(c.env, { limit });

  return c.json({ recovered, limit });
});
