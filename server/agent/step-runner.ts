import { AppError, DeadlineExceededError } from '../errors.js';

export interface StepContext {
  deadline: number; // epoch ms by which the run must finish
}

export interface Step<T> {
  name: string;
  run: (ctx: StepContext) => Promise<T>;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

// Inline step runner: bounded retries with exponential backoff, and a
// wall-clock deadline. Before starting each step, check the deadline; if it
// would be exceeded, throw DeadlineExceededError *before* doing work so the
// lease can be released and a fresh invocation dispatched.
export async function runSteps<T>(
  steps: Array<Step<unknown>>,
  budgetSeconds: number,
): Promise<unknown[]> {
  const deadline = Date.now() + budgetSeconds * 1000;
  const ctx: StepContext = { deadline };
  const results: unknown[] = [];
  for (const step of steps) {
    if (Date.now() > deadline - 5000) {
      throw new DeadlineExceededError();
    }
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= MAX_RETRIES) {
      try {
        const r = await step.run(ctx);
        results.push(r);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        if (e instanceof DeadlineExceededError) throw e;
        const retryable = e instanceof AppError ? e.retryable : true;
        if (!retryable || attempt === MAX_RETRIES) throw e;
        attempt++;
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, backoff));
        if (Date.now() > deadline - 5000) throw new DeadlineExceededError();
      }
    }
    if (lastErr) throw lastErr;
  }
  return results;
}
