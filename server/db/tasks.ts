import type { Task, TaskEvent, TaskStatus, PatchSet, ErrorCode } from '../../shared/types.js';
import { collections, firestore } from '../firebase.js';
import { FieldValue } from 'firebase-admin/firestore';
import { randomHex } from '../crypto.js';

function fromDoc(id: string, data: Record<string, any>): Task {
  return {
    id,
    ownerId: data.ownerId,
    projectId: data.projectId,
    prompt: data.prompt,
    status: data.status as TaskStatus,
    commitMode: data.commitMode,
    baseSha: data.baseSha,
    baseTreeSha: data.baseTreeSha,
    branch: data.branch,
    patch: data.patch as PatchSet | undefined,
    commitSha: data.commitSha,
    commitUrl: data.commitUrl,
    pullRequestUrl: data.pullRequestUrl,
    errorCode: data.errorCode as ErrorCode | undefined,
    errorMessage: data.errorMessage,
    errorIssues: data.errorIssues as Task['errorIssues'],
    tokenUsage: data.tokenUsage,
    leaseExpiresAt: data.leaseExpiresAt?.toMillis?.() ?? data.leaseExpiresAt,
    runCount: data.runCount ?? 0,
    createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    updatedAt: data.updatedAt?.toMillis?.() ?? data.updatedAt,
  };
}

export async function createTask(input: {
  ownerId: string;
  projectId: string;
  prompt: string;
  commitMode: 'direct' | 'pull_request';
}): Promise<Task> {
  const id = randomHex(10);
  const now = Date.now();
  const doc: Omit<Task, 'id'> = {
    ...input,
    status: 'queued',
    runCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await collections.tasks().doc(id).set({
    ...doc,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await appendEvent(id, { type: 'created', message: `task queued: ${input.prompt.slice(0, 80)}` });
  return { id, ...doc };
}

export async function getTask(id: string): Promise<Task | undefined> {
  const snap = await collections.tasks().doc(id).get();
  if (!snap.exists) return undefined;
  return fromDoc(id, snap.data()!);
}

export async function getTaskOwned(id: string, ownerId: string): Promise<Task | undefined> {
  const t = await getTask(id);
  if (!t || t.ownerId !== ownerId) return undefined;
  return t;
}

export async function listTasksForProject(projectId: string, limit = 20): Promise<Task[]> {
  const snap = await collections
    .tasks()
    .where('projectId', '==', projectId)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => fromDoc(d.id, d.data()));
}

export async function countRunningTasks(ownerId: string): Promise<number> {
  const snap = await collections
    .tasks()
    .where('ownerId', '==', ownerId)
    .where('status', 'in', ['queued', 'running'])
    .count()
    .get();
  return snap.data().count ?? 0;
}

// Lease: atomically flip queued -> running and stamp leaseExpiresAt.
// Returns the task if this invocation won the lease, undefined otherwise.
export async function leaseTask(
  taskId: string,
  leaseSeconds: number,
): Promise<Task | undefined> {
  const ref = collections.tasks().doc(taskId);
  const now = Date.now();
  const expires = now + leaseSeconds * 1000;
  let won: Task | undefined;
  await firestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data()!;
    const status = data.status as TaskStatus;
    const leaseExp = data.leaseExpiresAt?.toMillis?.() ?? data.leaseExpiresAt;
    const terminal = ['succeeded', 'failed', 'conflict'].includes(status);
    const liveLease = status === 'running' && leaseExp && leaseExp > now;
    if (terminal || liveLease) return;
    const runCount = (data.runCount ?? 0) + 1;
    tx.update(ref, {
      status: 'running',
      leaseExpiresAt: new Date(expires),
      runCount,
      updatedAt: new Date(now),
    });
    won = fromDoc(taskId, { ...data, status: 'running', leaseExpiresAt: expires, runCount });
  });
  return won;
}

export async function releaseLease(taskId: string): Promise<void> {
  await collections.tasks().doc(taskId).update({
    status: 'queued',
    leaseExpiresAt: FieldValue.delete(),
    updatedAt: new Date(),
  });
}

export async function updateTask(taskId: string, patch: Partial<Task>): Promise<void> {
  const { id, ...rest } = patch as any;
  await collections.tasks().doc(taskId).set(
    { ...rest, updatedAt: new Date() },
    { merge: true },
  );
}

export async function appendEvent(
  taskId: string,
  evt: Omit<TaskEvent, 'id' | 'taskId' | 'createdAt'> & { createdAt?: number },
): Promise<void> {
  const id = randomHex(8);
  const now = evt.createdAt ?? Date.now();
  await collections.taskEvents(taskId).doc(id).set({
    id,
    taskId,
    type: evt.type,
    message: evt.message,
    data: evt.data,
    createdAt: new Date(now),
  });
}

export async function listEvents(taskId: string): Promise<TaskEvent[]> {
  const snap = await collections
    .taskEvents(taskId)
    .orderBy('createdAt', 'asc')
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as any;
    return {
      id: data.id ?? d.id,
      taskId: data.taskId ?? taskId,
      type: data.type,
      message: data.message,
      data: data.data,
      createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    };
  });
}

// Find stale tasks: queued (never claimed) or running with expired lease.
export async function findStaleTasks(now = Date.now(), limit = 25): Promise<Task[]> {
  const running = await collections
    .tasks()
    .where('status', '==', 'running')
    .where('leaseExpiresAt', '<', new Date(now))
    .limit(limit)
    .get();
  const queued = await collections
    .tasks()
    .where('status', '==', 'queued')
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get();
  const out: Task[] = [];
  for (const d of running.docs) out.push(fromDoc(d.id, d.data()));
  for (const d of queued.docs) out.push(fromDoc(d.id, d.data()));
  return out.slice(0, limit);
}

// Phase 3: reset a terminal (failed/conflict) task back to queued so it can be
// re-run with the same prompt. Clears pinned base, stored patch, commit info
// and error fields so the pipeline starts clean. Lease is released.
export async function resetTaskForRetry(taskId: string): Promise<Task> {
  const ref = collections.tasks().doc(taskId);
  const now = Date.now();
  await ref.update({
    status: 'queued',
    baseSha: FieldValue.delete(),
    baseTreeSha: FieldValue.delete(),
    branch: FieldValue.delete(),
    patch: FieldValue.delete(),
    commitSha: FieldValue.delete(),
    commitUrl: FieldValue.delete(),
    pullRequestUrl: FieldValue.delete(),
    errorCode: FieldValue.delete(),
    errorMessage: FieldValue.delete(),
    errorIssues: FieldValue.delete(),
    tokenUsage: FieldValue.delete(),
    leaseExpiresAt: FieldValue.delete(),
    updatedAt: new Date(now),
  });
  const t = await getTask(taskId);
  if (!t) throw new Error('task disappeared during retry reset');
  return t;
}

// Phase 3: sum token usage (completion + prompt) for tasks created today.
// Firestore has no server-side sum; fetch today's tasks (bounded by the daily
// task limit, so small) and aggregate in memory.
export async function sumTokenUsageToday(uid: string, now = Date.now()): Promise<number> {
  const startOfDay = new Date(Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  ));
  const snap = await collections
    .tasks()
    .where('ownerId', '==', uid)
    .where('createdAt', '>=', startOfDay)
    .limit(200)
    .get();
  let total = 0;
  for (const d of snap.docs) {
    const tu = d.data()?.tokenUsage as { total?: number } | undefined;
    if (tu && typeof tu.total === 'number') total += tu.total;
  }
  return total;
}
