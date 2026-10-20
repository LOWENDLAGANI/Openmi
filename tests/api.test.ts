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

const appEnv = {
  ...env,
  GITHUB_APP_ID: '123456',
  GITHUB_APP_CLIENT_ID: 'Iv1.abcdef',
  GITHUB_APP_SLUG: 'openmi',
  GITHUB_APP_PRIVATE_KEY: 'unused-for-signature-tests',
  GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret',
} as unknown as Env;

const PROTECTED = [
  ['GET', '/api/me'],
  ['POST', '/api/github/link'],
  ['POST', '/api/github/app/install'],
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

describe('GitHub App endpoints', () => {
  it('reports app availability in public config', async () => {
    const disabled = (await (await app.request('/api/config', {}, env)).json()) as {
      githubApp: { enabled: boolean };
    };
    expect(disabled.githubApp.enabled).toBe(false);

    const enabled = (await (await app.request('/api/config', {}, appEnv)).json()) as {
      githubApp: { enabled: boolean; slug: string | null };
    };
    expect(enabled.githubApp).toEqual({ enabled: true, slug: 'openmi' });
  });

  it('serves the install callback without a bearer token', async () => {
    const response = await app.request(
      '/api/github-app/callback?installation_id=1&state=forged',
      {}, 
      appEnv,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?github_app=error');
  });

  it('treats a pending org approval as pending, not an error', async () => {
    const response = await app.request(
      '/api/github-app/callback?setup_action=request&state=whatever',
      {},
      appEnv,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?github_app=pending');
  });

  it('rejects unsigned webhooks with a 401', async () => {
    const response = await app.request(
      '/api/webhooks/github',
      { method: 'POST', headers: { 'x-github-event': 'ping' }, body: '{}' },
      appEnv,
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/signature/i);
  });

  it('accepts a correctly signed but irrelevant event', async () => {
    const payload = JSON.stringify({ zen: 'Design for failure.' });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('webhook-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)),
    );
    const hex = [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');

    const response = await app.request(
      '/api/webhooks/github',
      {
        method: 'POST',
        headers: {
          'x-github-event': 'ping',
          'x-hub-signature-256': `sha256=${hex}`,
          'content-type': 'application/json',
        },
        body: payload,
      },
      appEnv,
    );
    expect(response.status).toBe(204);
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
