import { describe, expect, it } from 'vitest';
import { app } from '../worker/app';
import type { Env } from '../worker/env';

/** Minimal env: these tests only exercise routing, headers, and the auth gate. */
const env = {
  ASSETS: { fetch: async () => new Response('assets') },
  TASK_WORKFLOW: {},
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  GITHUB_TOKEN_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
  OPENROUTER_API_KEY: 'key',
  OPENMI_MODEL: 'test-model',
  DAILY_TASK_LIMIT: '5',
  MAX_CONCURRENT_TASKS: '2',
  DEFAULT_COMMIT_MODE: 'direct',
} as unknown as Env;

const PROTECTED = [
  ['GET', '/api/me'],
  ['POST', '/api/github/link'],
  ['GET', '/api/github/repos'],
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['GET', '/api/projects/00000000-0000-4000-8000-000000000000/tasks'],
  ['POST', '/api/tasks'],
  ['GET', '/api/tasks/00000000-0000-4000-8000-000000000000'],
] as const;

describe('public endpoints', () => {
  it('serves /api/health without a session', async () => {
    const response = await app.request('/api/health', {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; missing: string[] };
    expect(body.ok).toBe(true);
    expect(body.missing).toEqual([]);
  });

  it('serves public runtime config without leaking secrets', async () => {
    const response = await app.request('/api/config', {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.supabaseUrl).toBe('https://test.supabase.co');
    expect(body.ready).toBe(true);
    expect(JSON.stringify(body)).not.toContain('service');
    expect(body).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('reports missing configuration instead of throwing', async () => {
    const response = await app.request('/api/health', {}, { ...env, SUPABASE_URL: '' } as Env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; missing: string[] };
    expect(body.ok).toBe(false);
    expect(body.missing).toContain('SUPABASE_URL');
  });
});

describe('auth gate', () => {
  for (const [method, path] of PROTECTED) {
    it(`rejects unauthenticated ${method} ${path}`, async () => {
      const response = await app.request(path, { method }, env);
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHENTICATED');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    });
  }

  it('rejects malformed and unsigned tokens', async () => {
    for (const token of ['garbage', 'a.b.c']) {
      const response = await app.request(
        '/api/me',
        { headers: { authorization: `Bearer ${token}` } },
        env,
      );
      expect(response.status).toBe(401);
    }
  });

  it('does not mark public responses as private', async () => {
    const response = await app.request('/api/health', {}, env);
    expect(response.headers.get('cache-control')).toBeNull();
  });
});

describe('not found', () => {
  it('returns a JSON 404 for unknown API paths', async () => {
    const response = await app.request('/api/nope', {}, env);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('security headers', () => {
  it('sets hardening headers on API responses', async () => {
    const response = await app.request('/api/health', {}, env);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});
