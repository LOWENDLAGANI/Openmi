import { Hono, type Context } from 'hono';
import { requireAuth, getUid } from '../auth.js';
import { requireProject } from '../db/projects.js';
import { createTask, getTaskOwned, listEvents, countRunningTasks, findStaleTasks, resetTaskForRetry, appendEvent } from '../db/tasks.js';
import { consumeTaskQuota } from '../db/quota.js';
import { resolveGithubAuth } from '../github/auth.js';
import { dispatchTask } from '../dispatch.js';
import { env } from '../env.js';
import { AppError, issue, summarizeIssues } from '../errors.js';
import type { Issue } from '../../shared/types.js';

const app = new Hono();

// Auth is attached per route: a wildcard middleware here would also guard
// the internal runner, the cron endpoint and the GitHub webhook.
const MAX_PROMPT_CHARS = 4000;

// Accept a prompt (202) -> quota reserved -> runner dispatched.
app.post('/tasks', requireAuth, async (c) => {
  const uid = getUid(c);
  const body = await c.req.json().catch(() => ({}));
  const projectId = body?.projectId as string | undefined;
  const prompt = (body?.prompt as string | undefined)?.trim();
  // Collect every input problem at once instead of failing on the first.
  const issues: Issue[] = [];
  if (!projectId) {
    issues.push(issue('MISSING_PROJECT_ID', 'projectId is required', { field: 'projectId' }));
  }
  if (!prompt) {
    issues.push(issue('MISSING_PROMPT', 'prompt is required', { field: 'prompt' }));
  } else if (prompt.length > MAX_PROMPT_CHARS) {
    issues.push(
      issue('PROMPT_TOO_LONG', `prompt too long (${prompt.length} > ${MAX_PROMPT_CHARS} chars)`, {
        field: 'prompt',
      }),
    );
  }
  if (issues.length) {
    throw new AppError('INVALID_INPUT', summarizeIssues(issues), { details: { issues } });
  }
  // Narrowed by the MISSING_* issues above.
  const projectIdValue = projectId!;
  const promptValue = prompt!;
  const project = await requireProject(projectIdValue, uid);

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
    prompt: promptValue,
    commitMode: project.commitMode,
  });

  // Opportunistic sweep + dispatch.
  dispatchTask(task.id);
  sweepStale().catch(() => {});

  return c.json({ task, quota }, 202);
});

app.get('/tasks/:id', requireAuth, async (c) => {
  const uid = getUid(c);
  const task = await getTaskOwned(requireTaskId(c), uid);
  if (!task) throw new AppError('NOT_FOUND', 'task not found');
  const events = await listEvents(task.id);
  return c.json({ task, events });
});

// Phase 3: retry a failed/conflict task. Consumes a fresh quota slot and
// re-dispatches; the pipeline re-pins the base and regenerates from scratch.
app.post('/tasks/:id/retry', requireAuth, async (c) => {
  const uid = getUid(c);
  const task = await getTaskOwned(requireTaskId(c), uid);
  if (!task) throw new AppError('NOT_FOUND', 'task not found');
  if (task.status !== 'failed' && task.status !== 'conflict') {
    throw new AppError('INVALID_INPUT', 'only failed or conflicted tasks can be retried', {
      status: 409,
      details: {
        issues: [
          issue('NOT_RETRYABLE', `task status is "${task.status}", expected "failed" or "conflict"`, {
            field: 'status',
          }),
        ],
      },
    });
  }
  await consumeTaskQuota(uid, env.dailyTaskLimit());
  const reset = await resetTaskForRetry(task.id);
  await appendEvent(task.id, { type: 'redeployed', message: 'task retried by user' });
  dispatchTask(task.id).catch(() => {});
  return c.json({ task: reset }, 202);
});

// A path parameter that is missing is a bad request, not a crash further down.
function requireTaskId(c: Context): string {
  const id = c.req.param('id');
  if (!id) {
    throw new AppError('INVALID_INPUT', 'task id is required', {
      details: { issues: [issue('MISSING_ID', 'task id is required', { field: 'id' })] },
    });
  }
  return id;
}

async function sweepStale() {
  const stale = await findStaleTasks();
  for (const t of stale.slice(0, 5)) {
    await dispatchTask(t.id);
  }
}

export default app;
