import { log } from '../lib/logger';

type BackgroundRunner = (promise: Promise<unknown>) => void;

/**
 * Post-response work. Cloudflare provides `ctx.waitUntil`; Vercel provides
 * `waitUntil` from `@vercel/functions`. Each platform entry installs its own
 * implementation, and the shared code stays unaware of which one it is.
 *
 * Without an installed runner (tests, local Node) the promise still executes;
 * it just is not guaranteed to outlive the process.
 */
let runner: BackgroundRunner | null = null;

export function setBackgroundRunner(implementation: BackgroundRunner): void {
  runner = implementation;
}

export function background(promise: Promise<unknown>, label = 'background'): void {
  const guarded = promise.catch((error: unknown) => {
    log.error('background.rejected', {
      label,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  if (runner) {
    try {
      runner(guarded);
      return;
    } catch (error) {
      log.warn('background.runner_failed', {
        label,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  void guarded;
}
