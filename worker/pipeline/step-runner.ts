import { isAppError } from '../lib/errors';

/**
 * The pipeline is written against this tiny interface instead of a specific
 * durable-execution engine, so the same code runs on Cloudflare Workflows
 * (hardware-backed step persistence) and on plain serverless functions
 * (retries + database-backed resumption).
 */
export interface StepOptions {
  /** Extra attempts after the first. Defaults to 2. */
  retries?: number;
  timeoutMs?: number;
}

export interface StepRunner {
  run<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T>;
}

/** Signals that the current invocation is out of time; work must be re-dispatched. */
export class DeadlineExceededError extends Error {
  constructor(message = 'Task run exceeded its time budget') {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

export function isDeadlineExceeded(error: unknown): error is DeadlineExceededError {
  return error instanceof DeadlineExceededError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs steps inline with bounded retries. Non-retryable `AppError`s (policy,
 * config, not-found) fail immediately instead of burning attempts or tokens.
 */
export function createInlineStepRunner(deadlineAt: number): StepRunner {
  return {
    async run<T>(name: string, fn: () => Promise<T>, options: StepOptions = {}): Promise<T> {
      const retries = options.retries ?? 2;
      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (Date.now() >= deadlineAt) throw new DeadlineExceededError();

        try {
          return await fn();
        } catch (error) {
          lastError = error;

          if (isDeadlineExceeded(error)) throw error;
          if (isAppError(error) && !error.retryable) throw error;
          if (attempt === retries) break;

          const delay = Math.min(2000 * 2 ** attempt, 10_000);
          if (Date.now() + delay >= deadlineAt) throw new DeadlineExceededError();
          await sleep(delay);
        }
      }

      throw lastError instanceof Error ? lastError : new Error(`Step failed: ${name}`);
    },
  };
}
