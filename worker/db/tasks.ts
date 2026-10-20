import type {
  PatchFileSummary,
  TaskDetail,
  TaskEventLevel,
  TaskSummary,
} from '../../shared/types';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { db } from './client';
import type { TaskEventRow, TaskRow } from './types';

function dbError(context: string, error: { message: string } | null): never {
  log.error('db.error', { context, message: error?.message });
  throw new AppError('INTERNAL', 'Database operation failed', {
    retryable: true,
    cause: error,
  });
}

export function toTaskSummary(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    prompt: row.prompt,
    status: row.status,
    summary: row.summary,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    commitSha: row.commit_sha,
    commitUrl: row.commit_url,
    branch: row.branch,
    filesChanged: row.files_changed,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function patchFiles(patch: unknown): PatchFileSummary[] {
  if (!patch || typeof patch !== 'object') return [];
  const files = (patch as { files?: unknown }).files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file): PatchFileSummary[] => {
    if (!file || typeof file !== 'object') return [];
    const { path, operation, reason } = file as {
      path?: unknown;
      operation?: unknown;
      reason?: unknown;
    };
    if (typeof path !== 'string' || (operation !== 'create' && operation !== 'update')) {
      return [];
    }
    return [
      {
        path,
        operation,
        ...(typeof reason === 'string' ? { reason } : {}),
      },
    ];
  });
}

export async function createTask(
  env: Env,
  input: { projectId: string; ownerId: string; prompt: string },
): Promise<TaskRow> {
  const { data, error } = await db(env)
    .from('tasks')
    .insert({
      project_id: input.projectId,
      owner_id: input.ownerId,
      prompt: input.prompt,
      status: 'queued',
    })
    .select('*')
    .single();

  if (error || !data) dbError('tasks.insert', error);
  return data as TaskRow;
}

export async function setWorkflowInstance(
  env: Env,
  taskId: string,
  instanceId: string,
): Promise<void> {
  const { error } = await db(env)
    .from('tasks')
    .update({ workflow_instance_id: instanceId })
    .eq('id', taskId);

  if (error) dbError('tasks.set_workflow', error);
}

export async function getTaskRow(env: Env, taskId: string): Promise<TaskRow> {
  const { data, error } = await db(env)
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .maybeSingle();

  if (error) dbError('tasks.get', error);
  if (!data) throw new AppError('NOT_FOUND', 'Task not found');
  return data as TaskRow;
}

export async function getTaskForOwner(
  env: Env,
  ownerId: string,
  taskId: string,
): Promise<TaskRow> {
  const row = await getTaskRow(env, taskId);
  if (row.owner_id !== ownerId) throw new AppError('NOT_FOUND', 'Task not found');
  return row;
}

export async function listTaskEvents(env: Env, taskId: string): Promise<TaskEventRow[]> {
  const { data, error } = await db(env)
    .from('task_events')
    .select('*')
    .eq('task_id', taskId)
    .order('id', { ascending: true })
    .limit(200);

  if (error) dbError('task_events.list', error);
  return (data ?? []) as TaskEventRow[];
}

export function toTaskDetail(row: TaskRow, events: TaskEventRow[]): TaskDetail {
  return {
    ...toTaskSummary(row),
    files: patchFiles(row.patch),
    events: events.map((event) => ({
      seq: event.id,
      level: event.level,
      message: event.message,
      createdAt: event.created_at,
    })),
  };
}

export async function listProjectTasks(
  env: Env,
  ownerId: string,
  projectId: string,
  limit = 20,
): Promise<TaskSummary[]> {
  const { data, error } = await db(env)
    .from('tasks')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) dbError('tasks.list', error);
  return ((data ?? []) as TaskRow[]).map(toTaskSummary);
}

/**
 * Claims (or re-claims) a task for this invocation.
 *
 * Queued tasks transition to running; a running task is only claimable when its
 * lease has expired, which is what lets a crashed serverless invocation be
 * recovered without two runners working on the same task.
 */
export async function leaseTask(
  env: Env,
  taskId: string,
  leaseMs: number,
): Promise<{ row: TaskRow; claimed: boolean }> {
  const nowIso = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();

  const { data: queued, error } = await db(env)
    .from('tasks')
    .update({ status: 'running', started_at: nowIso, lease_expires_at: leaseUntil })
    .eq('id', taskId)
    .eq('status', 'queued')
    .select('*')
    .maybeSingle();

  if (error) dbError('tasks.lease_queued', error);
  if (queued) return { row: queued as TaskRow, claimed: true };

  const { data: stale, error: staleError } = await db(env)
    .from('tasks')
    .update({ lease_expires_at: leaseUntil })
    .eq('id', taskId)
    .eq('status', 'running')
    .or(`lease_expires_at.is.null,lease_expires_at.lt.${nowIso}`)
    .select('*')
    .maybeSingle();

  if (staleError) dbError('tasks.lease_running', staleError);
  if (stale) return { row: stale as TaskRow, claimed: true };

  return { row: await getTaskRow(env, taskId), claimed: false };
}

/** Releases the lease so the next dispatch can pick the task up immediately. */
export async function requeueTask(env: Env, taskId: string): Promise<void> {
  const { error } = await db(env)
    .from('tasks')
    .update({ lease_expires_at: null })
    .eq('id', taskId)
    .eq('status', 'running');

  if (error) dbError('tasks.requeue', error);
}

export interface StaleTaskRef {
  id: string;
  owner_id: string;
  project_id: string;
}

/** Tasks whose lease (or initial dispatch) never completed. */
export async function listStaleTasks(
  env: Env,
  staleBeforeIso: string,
  limit = 10,
): Promise<StaleTaskRef[]> {
  const [queued, running] = await Promise.all([
    db(env)
      .from('tasks')
      .select('id, owner_id, project_id')
      .eq('status', 'queued')
      .lt('created_at', staleBeforeIso)
      .order('created_at', { ascending: true })
      .limit(limit),
    db(env)
      .from('tasks')
      .select('id, owner_id, project_id')
      .eq('status', 'running')
      .or(`lease_expires_at.is.null,lease_expires_at.lt.${staleBeforeIso}`)
      .order('created_at', { ascending: true })
      .limit(limit),
  ]);

  if (queued.error) dbError('tasks.stale_queued', queued.error);
  if (running.error) dbError('tasks.stale_running', running.error);

  const seen = new Set<string>();
  const merged: StaleTaskRef[] = [];
  for (const row of [...(queued.data ?? []), ...(running.data ?? [])] as StaleTaskRef[]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return merged;
}

export async function setTaskBase(
  env: Env,
  taskId: string,
  input: { baseBranch: string; baseCommitSha: string },
): Promise<void> {
  const { error } = await db(env)
    .from('tasks')
    .update({
      base_branch: input.baseBranch,
      base_commit_sha: input.baseCommitSha,
    })
    .eq('id', taskId);

  if (error) dbError('tasks.set_base', error);
}

export async function saveTaskPatch(
  env: Env,
  taskId: string,
  input: {
    patch: unknown;
    summary: string;
    model: string;
    filesChanged: number;
    promptTokens: number;
    completionTokens: number;
  },
): Promise<void> {
  const { error } = await db(env)
    .from('tasks')
    .update({
      patch: input.patch,
      summary: input.summary,
      model: input.model,
      files_changed: input.filesChanged,
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
    })
    .eq('id', taskId);

  if (error) dbError('tasks.save_patch', error);
}

export async function completeTask(
  env: Env,
  taskId: string,
  input: {
    commitSha: string;
    commitUrl: string;
    branch: string;
    filesChanged: number;
  },
): Promise<void> {
  const { error } = await db(env)
    .from('tasks')
    .update({
      status: 'succeeded',
      commit_sha: input.commitSha,
      commit_url: input.commitUrl,
      branch: input.branch,
      files_changed: input.filesChanged,
      finished_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) dbError('tasks.complete', error);
}

export async function failTask(
  env: Env,
  taskId: string,
  input: { code: string; message: string },
): Promise<void> {
  const { error } = await db(env)
    .from('tasks')
    .update({
      status: 'failed',
      error_code: input.code,
      error_message: input.message.slice(0, 800),
      finished_at: new Date().toISOString(),
    })
    .eq('id', taskId);

  if (error) dbError('tasks.fail', error);
}

export async function addTaskEvent(
  env: Env,
  taskId: string,
  message: string,
  level: TaskEventLevel = 'info',
): Promise<void> {
  const { error } = await db(env)
    .from('task_events')
    .insert({ task_id: taskId, level, message: message.slice(0, 500) });

  // Timeline writes must never fail a task.
  if (error) log.warn('task_events.insert_failed', { message: error.message, taskId });
}
