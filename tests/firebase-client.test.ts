import { describe, it, expect, vi } from 'vitest';
import { getApps } from 'firebase/app';

// Regression: the SPA used to call getAuth() before initializeApp() had run,
// which surfaced the raw SDK error
//   "app/no-app: Firebase: No Firebase App '[DEFAULT]' has been created"
// whenever /api/config could not be loaded. The bootstrap must be idempotent
// (React StrictMode mounts twice) and every failure must be actionable.
describe('client Firebase bootstrap', () => {
  it('never surfaces the raw app/no-app SDK error', async () => {
    vi.resetModules();
    const { firebaseAuth } = await import('../src/lib/firebase');
    let message = '';
    try {
      firebaseAuth();
    } catch (e: any) {
      message = e?.message ?? String(e);
    }
    expect(message).not.toContain('app/no-app');
    expect(message).not.toContain('No Firebase App');
    expect(message).not.toContain('initializeApp() first');
  });

  it('initialises the app exactly once when called concurrently', async () => {
    vi.resetModules();
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          firebase: {
            apiKey: 'test-api-key',
            authDomain: 'test-project.firebaseapp.com',
            projectId: 'test-project',
          },
          githubAppConfigured: false,
          defaultCommitMode: 'direct',
          dailyTaskLimit: 5,
          maxConcurrentTasks: 2,
          model: 'test-model',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    try {
      const { initFirebase } = await import('../src/lib/firebase');
      await Promise.all([initFirebase(), initFirebase(), initFirebase()]);
      // A second initializeApp() would have thrown app/duplicate-app.
      expect(getApps().length).toBe(1);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('reports an unreachable API instead of an SDK error', async () => {
    vi.resetModules();
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch;
    try {
      const { getConfig } = await import('../src/lib/firebase');
      await expect(getConfig()).rejects.toThrow(/API is unreachable/i);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  it('reports an HTML response (SPA fallback) instead of a JSON parse error', async () => {
    vi.resetModules();
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    try {
      const { getConfig } = await import('../src/lib/firebase');
      await expect(getConfig()).rejects.toThrow(/did not return JSON/i);
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
