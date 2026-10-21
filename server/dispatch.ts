import { env } from './env.js';
import { AppError } from './errors.js';
import { timingSafeEqual } from './crypto.js';

// Self-dispatch: POST to our own /api/internal/run-task. The runner endpoint
// answers 202 immediately and executes in the background (Vercel keeps the
// function alive until the event loop drains, bounded by maxDuration).
export async function dispatchTask(taskId: string): Promise<void> {
  const token = env.internalTaskToken();
  if (!token) throw new AppError('CONFIG_ERROR', 'INTERNAL_TASK_TOKEN not set');
  const base = env.internalDispatchUrl() ?? env.appOrigin();
  if (!base) throw new AppError('CONFIG_ERROR', 'APP_ORIGIN (or INTERNAL_DISPATCH_URL) not set');
  const url = `${base.replace(/\/$/, '')}/api/internal/run-task`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openmi-internal': token,
      },
      body: JSON.stringify({ taskId }),
    });
  } catch (e: any) {
    // Dispatch is best-effort; the cron sweep + opportunistic sweep recover.
    console.warn(`dispatch failed for ${taskId}: ${e.message}`);
  }
}

export function verifyInternalToken(header: string | undefined): void {
  const expected = env.internalTaskToken();
  if (!expected) throw new AppError('CONFIG_ERROR', 'INTERNAL_TASK_TOKEN not set');
  if (!header || !timingSafeEqual(header, expected)) {
    throw new AppError('UNAUTHENTICATED', 'invalid internal token');
  }
}

export function verifyCronToken(header: string | undefined): void {
  const expected = env.cronSecret();
  if (!expected) throw new AppError('CONFIG_ERROR', 'CRON_SECRET not set');
  // Vercel cron sends "Authorization: Bearer <CRON_SECRET>"
  const token = header?.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token || !timingSafeEqual(token, expected)) {
    throw new AppError('UNAUTHENTICATED', 'invalid cron token');
  }
}
