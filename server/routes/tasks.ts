import { Hono } from 'hono';
import { requireAuth, getUid } from '../auth.js';
import { requireProject } from '../db/projects.js';
import { createTask, getTaskOwned, listEvents, countRunningTasks, findStaleTasks, resetTaskForRetry, appendEvent } from '../db/tasks.js';
import { consumeTaskQuota } from '../db/quota.js';
import { resolveGithubAuth } from '../github/auth.js';
import { dispatchTask } from '../dispatch.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';

const app = new Hono();

app.use('*', requireAuth);

// Accept a prompt (202) -> quota reserved -> runner dispatched.
app.post('/tasks', async (c) => {
  const uid = getUid(c);
  const body = await c.req.json().catch(() => ({}));
  const projectId = body?.projectId as string | undefined;
  const prompt = (body?.prompt as string | undefined)?.trim();
  if (!projectId || !prompt) {
    throw new AppError('INVALID_INPUT', 'projectId and prompt are required');
  }
  if (prompt.length > 4000) {
    throw new AppError('INVALID_INPUT', 'prompt too long (max 4000 chars)');
  }
  const project = await requireProject(projectId, uid);

  // Require a GitHub credential.
  await resolveGithubAuth(uid); // throws GITHUB_NOT_CONNECTED if none

  // Concurrent task limit.
  const running = await countRunningTasks(uid);
  if (running >= env.maxConcurrentTasks()) {
    throw new AppError('TOO_MANY_RUNNING_TASKS', 'too many tasks in flight', {
      details: { limit: env.maxConcurrentTasks(), running },
    });
  }

  // Atomic quota consume.
  const quota = await consumeTaskQuota(uid, env.dailyTaskLimit());

  const task = await createTask({
    ownerId: uid,
    projectId: project.id,
    prompt,
    commitMode: project.commitMode,
  });

  // Opportunistic sweep + dispatch.
  dispatchTask(task.id);
  sweepStale().catch(() => {});

  return c.json({ task, quota }, 202);
});

app.get('/tasks/:id', async (c) => {
  const uid = getUid(c);
  const task = await getTaskOwned(c.req.param('id'), uid);
  if (!task) throw new AppError('NOT_FOUND', 'task not found');
  const events = await listEvents(task.id);
  return c.json({ task, events });
});

// Phase 3: retry a failed/conflict task. Consumes a fresh quota slot and
// re-dispatches; the pipeline re-pins the base and regenerates from scratch.
app.post('/tasks/:id/retry', async (c) => {
  const uid = getUid(c);
  const task = await getTaskOwned(c.req.param('id'), uid);
  if (!task) throw new AppError('NOT_FOUND', 'task not found');
  if (task.status !== 'failed' && task.status !== 'conflict') {
    throw new AppError('INVALID_INPUT', 'only failed or conflicted tasks can be retried', {
      status: 409,
    });
  }
  await consumeTaskQuota(uid, env.dailyTaskLimit());
  const reset = await resetTaskForRetry(task.id);
  await appendEvent(task.id, { type: 'redeployed', message: 'task retried by user' });
  dispatchTask(task.id).catch(() => {});
  return c.json({ task: reset }, 202);
});

async function sweepStale() {
  const stale = await findStaleTasks();
  for (const t of stale.slice(0, 5)) {
    await dispatchTask(t.id);
  }
}

export default app;
