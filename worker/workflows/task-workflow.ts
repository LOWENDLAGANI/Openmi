import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../env';
import { isAppError } from '../lib/errors';
import { runTaskPipeline, type PipelineResult } from '../pipeline/run-task';
import type { StepOptions, StepRunner } from '../pipeline/step-runner';
import type { TaskWorkflowParams } from './types';

function toStepConfig(options: StepOptions | undefined): {
  retries: { limit: number; delay: number; backoff: 'exponential' };
  timeout: number;
} {
  return {
    retries: { limit: options?.retries ?? 2, delay: 3, backoff: 'exponential' },
    timeout: Math.max(30, Math.round((options?.timeoutMs ?? 120_000) / 1000)),
  };
}

/**
 * Cloudflare Workflows adapter.
 *
 * The pipeline itself is platform-neutral (see `worker/pipeline/run-task.ts`);
 * this class only maps steps onto the Workflows engine and converts
 * non-retryable app errors into `NonRetryableError` so the engine stops
 * retrying work that cannot succeed.
 */
export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskWorkflowParams> {
  override async run(
    event: Readonly<WorkflowEvent<TaskWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<PipelineResult> {
    const runner: StepRunner = {
      run<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> {
        const body = async (): Promise<never> => {
          try {
            return (await fn()) as never;
          } catch (error) {
            if (isAppError(error) && !error.retryable) {
              throw new NonRetryableError(`${error.code}: ${error.message}`);
            }
            throw error;
          }
        };

        const promise = step.do(name, toStepConfig(options), body);
        return promise as unknown as Promise<T>;
      },
    };

    return runTaskPipeline(this.env, event.payload, runner);
  }
}
