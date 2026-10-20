import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker/env';
import { DeadlineExceededError } from '../worker/pipeline/step-runner';
import { setBackgroundRunner } from '../worker/platform/background';

const mocks = vi.hoisted(() => ({
  runTaskPipeline: vi.fn(),
  requeueTask: vi.fn(),
  startTaskRun: vi.fn(),
  listStaleTasks: vi.fn(),
}));

vi.mock('../worker/pipeline/run-task', () => ({ runTaskPipeline: mocks.runTaskPipeline }));
vi.mock('../worker/db/tasks', () => ({
  requeueTask: mocks.requeueTask,
  listStaleTasks: mocks.listStaleTasks,
}));
vi.mock('../worker/platform/dispatch', () => ({ startTaskRun: mocks.startTaskRun }));

import { app } from '../worker/app';

const env = {
  FIREBASE_PROJECT_ID: 'test-project',
  FIREBASE_API_KEY: 'test-api-key',
  FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  GITHUB_TOKEN_ENC_KEY: Buffer.alloc(32, 6).toString('base64'),
  OPENROUTER_API_KEY: 'key',
  OPENMI_MODEL: 'test',
  DAILY_TASK_LIMIT: '5',
  MAX_CONCURRENT_TASKS: '2',
  DEFAULT_COMMIT_MODE: 'direct',
  INTERNAL_TASK_TOKEN: 'internal-secret',
  CRON_SECRET: 'cron-secret',
} as unknown as Env;

const payload = {
  taskId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: 'bbbbbbbb-2222-4222-8222-222222222222',
  projectId: 'cccccccc-3333-4333-8333-333333333333',
};

const pending: Promise<unknown>[] = [];

async function flushBackground(): Promise<void> {
  await Promise.allSettled(pending.splice(0));
}

function runnerRequest(body: unknown, token?: string) {
  return app.request(
    '/api/internal/run-task',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-openmi-internal': token } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  pending.length = 0;
  setBackgroundRunner((promise) => pending.push(promise));
  mocks.runTaskPipeline.mockResolvedValue({ ok: true, commitSha: 'sha' });
  mocks.requeueTask.mockResolvedValue(undefined);
  mocks.startTaskRun.mockResolvedValue({ runner: 'http', instanceId: null });
  mocks.listStaleTasks.mockResolvedValue([]);
});

describe('POST /api/internal/run-task', () => {
  it('rejects a missing or wrong internal token', async () => {
    const missing = await runnerRequest(payload);
    expect(missing.status).toBe(401);

    const wrong = await runnerRequest(payload, 'not-the-token');
    expect(wrong.status).toBe(401);
  });

  it('validates the payload', async () => {
    const response = await runnerRequest({ taskId: 'nope' }, 'internal-secret');
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('accepts a valid dispatch and runs the pipeline after responding', async () => {
    const response = await runnerRequest(payload, 'internal-secret');
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });

    await flushBackground();
    expect(mocks.runTaskPipeline).toHaveBeenCalledWith(
      env,
      payload,
      expect.objectContaining({ run: expect.any(Function) }),
    );
  });

  it('releases the lease and re-dispatches when out of time', async () => {
    mocks.runTaskPipeline.mockRejectedValue(new DeadlineExceededError());

    const response = await runnerRequest(payload, 'internal-secret');
    expect(response.status).toBe(202);

    await flushBackground();
    expect(mocks.requeueTask).toHaveBeenCalledWith(env, payload.taskId);
    expect(mocks.startTaskRun).toHaveBeenCalledWith(env, payload, { await: true });
  });

  it('does not requeue on a genuine failure', async () => {
    mocks.runTaskPipeline.mockRejectedValue(new Error('policy rejected'));

    await runnerRequest(payload, 'internal-secret');
    await flushBackground();

    expect(mocks.requeueTask).not.toHaveBeenCalled();
    expect(mocks.startTaskRun).not.toHaveBeenCalled();
  });
});

describe('GET /api/cron/recover', () => {
  it('requires the cron secret', async () => {
    expect((await app.request('/api/cron/recover', {}, env)).status).toBe(401);
    expect(
      (
        await app.request(
          '/api/cron/recover',
          { headers: { authorization: 'Bearer wrong' } },
          env,
        )
      ).status,
    ).toBe(401);
  });

  it('re-dispatches stale tasks', async () => {
    mocks.listStaleTasks.mockResolvedValue([
      { id: payload.taskId, owner_id: payload.userId, project_id: payload.projectId },
    ]);

    const response = await app.request(
      '/api/cron/recover',
      { headers: { authorization: 'Bearer cron-secret' } },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recovered: 1, limit: 10 });
    expect(mocks.startTaskRun).toHaveBeenCalledWith(env, payload);
  });
});
