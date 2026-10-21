import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import type { TaskWorkflowParams } from '../workflows/types.js';
import { background } from './background.js';

export type TaskRunnerKind = 'cloudflare_workflow' | 'http';

export interface DispatchResult {
  runner: TaskRunnerKind;
  instanceId: string | null;
}

export function taskRunnerKind(env: Env): TaskRunnerKind | null {
  if (env.TASK_WORKFLOW) return 'cloudflare_workflow';
  if (internalRunnerUrl(env) && env.INTERNAL_TASK_TOKEN) return 'http';
  return null;
}

function internalRunnerUrl(env: Env): string | null {
  // INTERNAL_DISPATCH_URL wins so previews can point at a specific deployment;
  // otherwise the platform adapter supplies APP_ORIGIN.
  const base =
    env.INTERNAL_DISPATCH_URL?.trim().replace(/\/+$/, '') ||
    env.APP_ORIGIN?.trim().replace(/\/+$/, '');
  return base ? `${base}/api/internal/run-task` : null;
}

/**
 * Starts a task run: a durable Workflow on Cloudflare, a signed HTTP dispatch
 * to the runner endpoint everywhere else.
 */
export async function startTaskRun(
  env: Env,
  params: TaskWorkflowParams,
  options: { await?: boolean } = {},
): Promise<DispatchResult> {
  if (env.TASK_WORKFLOW) {
    const instance = await env.TASK_WORKFLOW.create({ params });
    return { runner: 'cloudflare_workflow', instanceId: instance.id };
  }

  const url = internalRunnerUrl(env);
  const token = env.INTERNAL_TASK_TOKEN;
  if (!url || !token) {
    throw new AppError(
      'CONFIG_ERROR',
      'No task runner is configured (need TASK_WORKFLOW or INTERNAL_DISPATCH_URL + INTERNAL_TASK_TOKEN)',
      { status: 503 },
    );
  }

  const dispatch = fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openmi-internal': token },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  }).then(async (response) => {
    if (response.status !== 202) {
      throw new AppError(
        'INTERNAL',
        `Task dispatch rejected (${response.status})`,
        { retryable: true },
      );
    }
    log.info('task.dispatched', { taskId: params.taskId, url });
  });

  if (options.await) {
    await dispatch;
  } else {
    // Fire-and-forget behind waitUntil: the HTTP response must not wait on the
    // runner function's cold start.
    background(dispatch, 'task-dispatch');
  }

  return { runner: 'http', instanceId: null };
}
