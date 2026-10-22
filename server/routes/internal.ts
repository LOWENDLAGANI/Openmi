import { Hono } from 'hono';
import { verifyInternalToken, verifyCronToken, dispatchTask } from '../dispatch.js';
import { runTaskPipeline } from '../agent/pipeline.js';
import { findStaleTasks } from '../db/tasks.js';
import { DeadlineExceededError } from '../errors.js';
import { AppError } from '../errors.js';

const app = new Hono();

// Internal: runs one task invocation. Authenticates with x-openmi-internal.
// Answers 202 immediately, then executes the pipeline in the background.
app.post('/internal/run-task', async (c) => {
  verifyInternalToken(c.req.header('x-openmi-internal'));
  const body = await c.req.json().catch(() => ({}));
  const taskId = body?.taskId as string | undefined;
  if (!taskId) {
    return c.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: 'taskId required',
          issues: [
            { code: 'MISSING_TASK_ID', message: 'taskId required', field: 'taskId' },
          ],
        },
      },
      422,
    );
  }

  // Kick off the pipeline without awaiting — Vercel keeps the function alive
  // while the event loop is non-empty (bounded by maxDuration).
  (async () => {
    try {
      await runTaskPipeline(taskId);
    } catch (e) {
      if (e instanceof DeadlineExceededError) {
        // Re-dispatch with a fresh budget.
        await dispatchTask(taskId);
      } else if (!(e instanceof AppError)) {
        console.error(`runner error for ${taskId}:`, e);
      }
    }
  })();

  return c.json({ accepted: true, taskId }, 202);
});

// Internal cron: re-dispatch stale tasks. Authenticates with Bearer CRON_SECRET.
app.get('/cron/recover', async (c) => {
  verifyCronToken(c.req.header('authorization'));
  const stale = await findStaleTasks();
  const dispatched: string[] = [];
  for (const t of stale) {
    await dispatchTask(t.id);
    dispatched.push(t.id);
  }
  return c.json({ recovered: dispatched.length, taskIds: dispatched });
});

export default app;
