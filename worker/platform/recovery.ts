import type { Env } from '../env';
import { listStaleTasks } from '../db/tasks';
import { log } from '../lib/logger';
import { startTaskRun } from './dispatch';

const DEFAULT_STALE_MS = 5 * 60 * 1000;

/**
 * Re-dispatches tasks that lost their runner (function timeout, crash, cold
 * start dropped). Safe by construction: the pipeline is idempotent and each
 * stage skips work already persisted.
 */
export async function recoverStaleTasks(
  env: Env,
  options: { limit?: number; staleAfterMs?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 10;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();

  const stale = await listStaleTasks(env, staleBefore, limit);
  let recovered = 0;

  for (const task of stale) {
    try {
      await startTaskRun(env, {
        taskId: task.id,
        userId: task.owner_id,
        projectId: task.project_id,
      });
      recovered += 1;
    } catch (error) {
      log.warn('recovery.dispatch_failed', {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (stale.length > 0) log.info('recovery.swept', { scanned: stale.length, recovered });
  return recovered;
}
