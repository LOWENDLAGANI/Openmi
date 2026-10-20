import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/env';
import { AppError } from '../worker/lib/errors';
import {
  DeadlineExceededError,
  createInlineStepRunner,
} from '../worker/pipeline/step-runner';
import { startTaskRun, taskRunnerKind } from '../worker/platform/dispatch';

const params = {
  taskId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: 'bbbbbbbb-2222-4222-8222-222222222222',
  projectId: 'cccccccc-3333-4333-8333-333333333333',
};

const baseEnv = {
  FIREBASE_PROJECT_ID: 'test-project',
  FIREBASE_API_KEY: 'test-api-key',
  FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  GITHUB_TOKEN_ENC_KEY: Buffer.alloc(32, 2).toString('base64'),
  OPENROUTER_API_KEY: 'key',
  OPENMI_MODEL: 'test',
  DAILY_TASK_LIMIT: '5',
  MAX_CONCURRENT_TASKS: '2',
  DEFAULT_COMMIT_MODE: 'direct',
} as unknown as Env;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createInlineStepRunner', () => {
  it('returns the step result', async () => {
    const runner = createInlineStepRunner(Date.now() + 60_000);
    await expect(runner.run('noop', async () => 42)).resolves.toBe(42);
  });

  it('retries retryable failures up to the configured limit', async () => {
    vi.useFakeTimers();
    const runner = createInlineStepRunner(Date.now() + 120_000);
    const step = vi.fn(async () => {
      throw new AppError('INTERNAL', 'transient', { retryable: true });
    });

    const promise = runner.run('flaky', step, { retries: 2 });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'INTERNAL' });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(step).toHaveBeenCalledTimes(3);
  });

  it('does not retry policy failures', async () => {
    const runner = createInlineStepRunner(Date.now() + 60_000);
    const step = vi.fn(async () => {
      throw new AppError('PATCH_REJECTED', 'protected path');
    });

    await expect(runner.run('policy', step, { retries: 5 })).rejects.toMatchObject({
      code: 'PATCH_REJECTED',
    });
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('stops with DeadlineExceeded when the invocation is out of time', async () => {
    vi.useFakeTimers();
    const runner = createInlineStepRunner(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(runner.run('late', async () => 'never')).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
  });

  it('does not start a retry that would run past the deadline', async () => {
    vi.useFakeTimers();
    const runner = createInlineStepRunner(Date.now() + 3000);
    const step = vi.fn(async () => {
      throw new AppError('INTERNAL', 'transient', { retryable: true });
    });

    const promise = runner.run('late-retry', step, { retries: 3 });
    const assertion = expect(promise).rejects.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    // Attempt 1 at t=0, attempt 2 after the 2 s backoff; the next 4 s backoff
    // would land past the deadline, so the runner gives up instead of starting it.
    expect(step).toHaveBeenCalledTimes(2);
  });
});

describe('task dispatch', () => {
  it('prefers the Cloudflare Workflow binding', async () => {
    const create = vi.fn(async () => ({ id: 'instance-123' }));
    const env = { ...baseEnv, TASK_WORKFLOW: { create } } as unknown as Env;

    await expect(startTaskRun(env, params)).resolves.toEqual({
      runner: 'cloudflare_workflow',
      instanceId: 'instance-123',
    });
    expect(create).toHaveBeenCalledWith({ params });
    expect(taskRunnerKind(env)).toBe('cloudflare_workflow');
  });

  it('dispatches over HTTP when no Workflow binding exists', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      ...baseEnv,
      APP_ORIGIN: 'https://openmi.vercel.app',
      INTERNAL_TASK_TOKEN: 'internal-token',
    } as unknown as Env;

    await expect(startTaskRun(env, params, { await: true })).resolves.toEqual({
      runner: 'http',
      instanceId: null,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openmi.vercel.app/api/internal/run-task');
    expect((init.headers as Record<string, string>)['x-openmi-internal']).toBe('internal-token');
    expect(JSON.parse(String(init.body))).toEqual(params);
  });

  it('treats a rejected dispatch as retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));

    const env = {
      ...baseEnv,
      APP_ORIGIN: 'https://openmi.vercel.app',
      INTERNAL_TASK_TOKEN: 'internal-token',
    } as unknown as Env;

    await expect(startTaskRun(env, params, { await: true })).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('fails clearly when no runner is configured', async () => {
    await expect(startTaskRun(baseEnv, params)).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
    expect(taskRunnerKind(baseEnv)).toBeNull();
  });

  it('uses INTERNAL_DISPATCH_URL ahead of APP_ORIGIN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })));
    const env = {
      ...baseEnv,
      APP_ORIGIN: 'https://production.example',
      INTERNAL_DISPATCH_URL: 'https://preview.example/',
      INTERNAL_TASK_TOKEN: 'tok',
    } as unknown as Env;

    await startTaskRun(env, params, { await: true });
    const [url] = vi.mocked(fetch).mock.calls[0] as unknown as [string];
    expect(url).toBe('https://preview.example/api/internal/run-task');
  });
});

describe('background runner', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('registers work with the installed platform runner', async () => {
    const { background, setBackgroundRunner } = await import('../worker/platform/background');
    const seen: Promise<unknown>[] = [];
    setBackgroundRunner((promise) => seen.push(promise));

    background(Promise.resolve('done'), 'test');
    expect(seen).toHaveLength(1);
    await expect(seen[0]).resolves.toBe('done');
  });

  it('swallows background failures instead of crashing the request', async () => {
    const { background, setBackgroundRunner } = await import('../worker/platform/background');
    const seen: Promise<unknown>[] = [];
    setBackgroundRunner((promise) => seen.push(promise));

    background(Promise.reject(new Error('boom')), 'test');
    await expect(seen[0]).resolves.toBeUndefined();
  });
});
