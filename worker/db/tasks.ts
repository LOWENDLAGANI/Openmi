import type {
  PatchFileSummary,
  TaskDetail,
  TaskEventLevel,
  TaskSummary,
} from '../../shared/types.js';
import type { Env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { firestore } from './client.js';
import type { TaskEventRow, TaskRow } from './types.js';

function dbError(context: string, error: { message: string } | null): never {
  log.error('db.error', { context, message: error?.message });
  throw new AppError('INTERNAL', 'Database operation failed', {
    retryable: true,
    cause: error,
  });
}

function nowIso(): string {
  return new Date().toISOString();
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
  const db = firestore(env);
  const now = nowIso();
  const taskId = crypto.randomUUID();
  const row: TaskRow = {
    id: taskId,
    project_id: input.projectId,
    owner_id: input.ownerId,
    prompt: input.prompt,
    status: 'queued',
    workflow_instance_id: null,
    base_branch: null,
    base_commit_sha: null,
    model: null,
    summary: null,
    patch: null,
    files_changed: 0,
    commit_sha: null,
    commit_url: null,
    branch: null,
    error_code: null,
    error_message: null,
    prompt_tokens: 0,
    completion_tokens: 0,
    created_at: now,
    started_at: null,
    finished_at: null,
    lease_expires_at: null,
  };
  try {
    await db.doc(`tasks/${taskId}`).set(row);
    return row;
  } catch (error) {
    dbError('tasks.insert', error as { message: string });
  }
}

export async function setWorkflowInstance(
  env: Env,
  taskId: string,
  instanceId: string,
): Promise<void> {
  const db = firestore(env);
  try {
    await db.doc(`tasks/${taskId}`).update({ workflow_instance_id: instanceId });
  } catch (error) {
    dbError('tasks.set_workflow', error as { message: string });
  }
}

export async function getTaskRow(env: Env, taskId: string): Promise<TaskRow> {
  const db = firestore(env);
  try {
    const snap = await db.doc(`tasks/${taskId}`).get();
    if (!snap.exists) throw new AppError('NOT_FOUND', 'Task not found');
    return snap.data() as TaskRow;
  } catch (error) {
    if (error instanceof AppError) throw error;
    dbError('tasks.get', error as { message: string });
  }
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
  const db = firestore(env);
  try {
    const snap = await db
      .collection(`tasks/${taskId}/events`)
      .orderBy('created_at', 'asc')
      .limit(200)
      .get();
    // Firestore auto-ids are not monotonic; assign a synthetic sequence from
    // the created_at ordering so the UI keeps a stable `seq` per event.
    return snap.docs.map((doc, index) => {
      const data = doc.data() as Omit<TaskEventRow, 'id'>;
      return { ...data, id: index + 1, task_id: taskId };
    });
  } catch (error) {
    dbError('task_events.list', error as { message: string });
  }
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
  const db = firestore(env);
  try {
    const snap = await db
      .collection('tasks')
      .where('owner_id', '==', ownerId)
      .where('project_id', '==', projectId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((doc) => toTaskSummary(doc.data() as TaskRow));
  } catch (error) {
    dbError('tasks.list', error as { message: string });
  }
}

/**
 * Claims (or re-claims) a task for this invocation, inside a Firestore
 * transaction so two concurrent runners can never both acquire it.
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
  const db = firestore(env);
  const taskRef = db.doc(`tasks/${taskId}`);
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
  try {
    return await db.runTransaction(async (t) => {
      const snap = await t.get(taskRef);
      if (!snap.exists) {
        throw new AppError('NOT_FOUND', 'Task not found');
      }
      const data = snap.data() as TaskRow;
      if (data.status === 'queued') {
        const next: TaskRow = {
          ...data,
          status: 'running',
          started_at: now,
          lease_expires_at: leaseUntil,
        };
        t.update(taskRef, {
          status: 'running',
          started_at: now,
          lease_expires_at: leaseUntil,
        });
        return { row: next, claimed: true };
      }
      if (
        data.status === 'running' &&
        (!data.lease_expires_at || data.lease_expires_at < now)
      ) {
        const next: TaskRow = { ...data, lease_expires_at: leaseUntil };
        t.update(taskRef, { lease_expires_at: leaseUntil });
        return { row: next, claimed: true };
      }
      return { row: data, claimed: false };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    dbError('tasks.lease', error as { message: string });
  }
}

/** Releases the lease so the next dispatch can pick the task up immediately. */
export async function requeueTask(env: Env, taskId: string): Promise<void> {
  const db = firestore(env);
  try {
    // Clearing an expired/absent lease is idempotent and harmless on
    // terminal tasks, so a plain update (no conditional) is sufficient.
    await db.doc(`tasks/${taskId}`).update({ lease_expires_at: null });
  } catch (error) {
    dbError('tasks.requeue', error as { message: string });
  }
}

export interface StaleTaskRef {
  id: string;
  owner_id: string;
  project_id: string;
}

/**
 * Tasks whose lease (or initial dispatch) never completed. Firestore cannot
 * express `lease_expires_at IS NULL OR lease_expires_at < X` in one query, so
 * the running set is fetched as two queries and merged with the queued set.
 */
export async function listStaleTasks(
  env: Env,
  staleBeforeIso: string,
  limit = 10,
): Promise<StaleTaskRef[]> {
  const db = firestore(env);
  try {
    const [queued, runningExpired, runningNull] = await Promise.all([
      db
        .collection('tasks')
        .where('status', '==', 'queued')
        .where('created_at', '<', staleBeforeIso)
        .orderBy('created_at', 'asc')
        .limit(limit)
        .get(),
      db
        .collection('tasks')
        .where('status', '==', 'running')
        .where('lease_expires_at', '<', staleBeforeIso)
        .orderBy('lease_expires_at', 'asc')
        .limit(limit)
        .get(),
      db
        .collection('tasks')
        .where('status', '==', 'running')
        .where('lease_expires_at', '==', null)
        .limit(limit)
        .get(),
    ]);
    const seen = new Set<string>();
    const merged: StaleTaskRef[] = [];
    for (const snap of [queued, runningExpired, runningNull]) {
      for (const doc of snap.docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        const data = doc.data() as StaleTaskRef;
        merged.push({ id: doc.id, owner_id: data.owner_id, project_id: data.project_id });
        if (merged.length >= limit) return merged;
      }
    }
    return merged;
  } catch (error) {
    dbError('tasks.stale', error as { message: string });
  }
}

export async function setTaskBase(
  env: Env,
  taskId: string,
  input: { baseBranch: string; baseCommitSha: string },
): Promise<void> {
  const db = firestore(env);
  try {
    await db.doc(`tasks/${taskId}`).update({
      base_branch: input.baseBranch,
      base_commit_sha: input.baseCommitSha,
    });
  } catch (error) {
    dbError('tasks.set_base', error as { message: string });
  }
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
  const db = firestore(env);
  try {
    await db.doc(`tasks/${taskId}`).update({
      patch: input.patch,
      summary: input.summary,
      model: input.model,
      files_changed: input.filesChanged,
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
    });
  } catch (error) {
    dbError('tasks.save_patch', error as { message: string });
  }
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
  const db = firestore(env);
  try {
    await db.doc(`tasks/${taskId}`).update({
      status: 'succeeded',
      commit_sha: input.commitSha,
      commit_url: input.commitUrl,
      branch: input.branch,
      files_changed: input.filesChanged,
      finished_at: nowIso(),
    });
  } catch (error) {
    dbError('tasks.complete', error as { message: string });
  }
}

export async function failTask(
  env: Env,
  taskId: string,
  input: { code: string; message: string },
): Promise<void> {
  const db = firestore(env);
  try {
    await db.doc(`tasks/${taskId}`).update({
      status: 'failed',
      error_code: input.code,
      error_message: input.message.slice(0, 800),
      finished_at: nowIso(),
    });
  } catch (error) {
    dbError('tasks.fail', error as { message: string });
  }
}

export async function addTaskEvent(
  env: Env,
  taskId: string,
  message: string,
  level: TaskEventLevel = 'info',
): Promise<void> {
  const db = firestore(env);
  try {
    await db.collection(`tasks/${taskId}/events`).add({
      level,
      message: message.slice(0, 500),
      created_at: nowIso(),
    });
  } catch (error) {
    // Timeline writes must never fail a task.
    log.warn('task_events.insert_failed', {
      message: error instanceof Error ? error.message : String(error),
      taskId,
    });
  }
}
