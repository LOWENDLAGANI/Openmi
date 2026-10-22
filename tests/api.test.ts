import { describe, it, expect, beforeAll } from 'vitest';
import app from '../server/index.js';

beforeAll(() => {
  process.env.GITHUB_TOKEN_ENC_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.INTERNAL_TASK_TOKEN = 'internal-token-123456789012345678901234567890';
  process.env.CRON_SECRET = 'cron-secret-1234';
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'webhook-secret-1234';
  process.env.FIREBASE_PROJECT_ID = 'test-project';
  process.env.FIREBASE_API_KEY = 'test-api-key';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n';
});

describe('API routing', () => {
  it('GET /api/health returns liveness + missing config (never values)', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.missingConfig)).toBe(true);
    expect(body.firebaseConfigured).toBe(true);
    // Must never leak secret values.
    expect(JSON.stringify(body)).not.toContain('internal-token');
    expect(JSON.stringify(body)).not.toContain('cron-secret');
  });

  it('GET /api/health lists the setup checklist without leaking values', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThan(10);
    const entry = body.checks.find((c: any) => c.name === 'FIREBASE_PROJECT_ID');
    expect(entry).toBeDefined();
    expect(entry.required).toBe(true);
    expect(typeof entry.present).toBe('boolean');
    expect(entry.purpose.length).toBeGreaterThan(10);
    expect(entry.howToSet.length).toBeGreaterThan(10);
    // Names and purposes only — never a value.
    expect(JSON.stringify(body)).not.toContain('test-api-key');
    expect(JSON.stringify(body)).not.toContain('test@test.iam.gserviceaccount.com');
  });

  it('GET /api/config returns public config', async () => {
    const res = await app.request('/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firebase.projectId).toBe('test-project');
    expect(body.firebase.apiKey).toBe('test-api-key');
    expect(typeof body.dailyTaskLimit).toBe('number');
  });

  it('authenticated routes return 401 without a token', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('malformed JWT returns 401 without network call', async () => {
    const res = await app.request('/api/me', {
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    expect(res.status).toBe(401);
  });

  it('unknown /api route returns 404 JSON', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('internal run-task rejects missing token', async () => {
    const res = await app.request('/api/internal/run-task', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('internal run-task rejects bad token', async () => {
    const res = await app.request('/api/internal/run-task', {
      method: 'POST',
      headers: { 'x-openmi-internal': 'wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('internal run-task returns 422 without taskId (token ok)', async () => {
    const res = await app.request('/api/internal/run-task', {
      method: 'POST',
      headers: { 'x-openmi-internal': 'internal-token-123456789012345678901234567890' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('internal run-task reports the missing field as an issue', async () => {
    const res = await app.request('/api/internal/run-task', {
      method: 'POST',
      headers: { 'x-openmi-internal': 'internal-token-123456789012345678901234567890' },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_INPUT');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues[0].field).toBe('taskId');
  });

  it('cron recover rejects missing token', async () => {
    const res = await app.request('/api/cron/recover');
    expect(res.status).toBe(401);
  });

  it('cron recover accepts Bearer CRON_SECRET', async () => {
    // This will try to query Firestore (not configured) — but auth passes first.
    // We expect either 200 or a 500 from Firestore, but NOT 401.
    const res = await app.request('/api/cron/recover', {
      headers: { Authorization: 'Bearer cron-secret-1234' },
    });
    expect(res.status).not.toBe(401);
  });

  it('github webhook rejects missing signature', async () => {
    const res = await app.request('/api/webhooks/github', {
      method: 'POST',
      body: JSON.stringify({ action: 'created' }),
    });
    expect(res.status).toBe(403);
  });
  it('retry endpoint requires auth', async () => {
    const res = await app.request('/api/tasks/abc/retry', { method: 'POST' });
    expect(res.status).toBe(401);
  });
  it('project files endpoint requires auth', async () => {
    const res = await app.request('/api/projects/abc/files');
    expect(res.status).toBe(401);
  });
});

// Regression: a wildcard `app.use('*', requireAuth)` inside a sub-app mounted
// at /api also guarded /api/internal/*, /api/cron/*, /api/webhooks/* and every
// unmatched path, so the runner, the cron sweep and the GitHub webhook were
// unreachable and unknown routes answered 401 instead of 404.
describe('public and internal routes are not blocked by user auth', () => {
  it('health and config stay public', async () => {
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/config')).status).toBe(200);
  });

  it('the GitHub webhook is not answered with 401', async () => {
    const res = await app.request('/api/webhooks/github', {
      method: 'POST',
      body: JSON.stringify({ action: 'created' }),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(403);
  });

  it('the internal runner reaches its own auth check', async () => {
    // No internal token -> 401 from the runner's own check, not a user-JWT 401.
    const res = await app.request('/api/internal/run-task', { method: 'POST' });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toMatch(/internal token/i);
  });

  it('the cron endpoint is not answered with 401 for a valid secret', async () => {
    const res = await app.request('/api/cron/recover', {
      headers: { Authorization: 'Bearer cron-secret-1234' },
    });
    expect(res.status).not.toBe(401);
  });

  it('unknown routes answer 404 JSON', async () => {
    const res = await app.request('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
