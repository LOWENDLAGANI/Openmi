import { describe, it, expect, beforeAll } from 'vitest';
import {
  assertSafePath,
  validatePatchSet,
  assertPatchTargets,
  assertSuperset,
  MAX_FILES,
  MAX_FILE_BYTES,
  type TreeEntry,
} from '../server/agent/policy.js';
import { encryptToken, decryptToken } from '../server/crypto.js';
import { dayKey } from '../server/db/quota.js';
import { parsePatch, classifyProviderStatus, buildProviderChain } from '../server/agent/model.js';
import { env } from '../server/env.js';
import { signInstallState, verifyInstallState } from '../server/github/webhook.js';
import { refundsQuota } from '../server/errors.js';
import { runSteps, type Step } from '../server/agent/step-runner.js';
import { DeadlineExceededError } from '../server/errors.js';
import { firebaseApp } from '../server/firebase.js';
import { configChecks, CONFIG_CATALOGUE } from '../server/config-catalogue.js';
import { missingConfigKeys } from '../server/env.js';

beforeAll(() => {
  process.env.GITHUB_TOKEN_ENC_KEY = Buffer.alloc(32, 1).toString('base64');
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-secret';
  process.env.GITHUB_APP_STATE_SECRET = 'test-state-secret';
});

describe('patch policy', () => {
  it('rejects absolute paths', () => {
    expect(() => assertSafePath('/etc/passwd')).toThrow();
  });
  it('rejects traversal', () => {
    expect(() => assertSafePath('../x')).toThrow();
    expect(() => assertSafePath('a/../../b')).toThrow();
  });
  it('rejects .github and env files', () => {
    expect(() => assertSafePath('.github/workflows/ci.yml')).toThrow();
    expect(() => assertSafePath('.env')).toThrow();
    expect(() => assertSafePath('config/.env.local')).toThrow();
    expect(() => assertSafePath('key.pem')).toThrow();
  });
  it('accepts normal source paths', () => {
    expect(() => assertSafePath('src/App.tsx')).not.toThrow();
    expect(() => assertSafePath('README.md')).not.toThrow();
  });
  it('rejects empty patch', () => {
    expect(() => validatePatchSet({ summary: '', files: [] })).toThrow();
  });
  it('rejects too many files', () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
      path: `f${i}.txt`,
      op: 'create' as const,
      content: 'x',
    }));
    expect(() => validatePatchSet({ summary: '', files })).toThrow();
  });
  it('rejects oversized files', () => {
    expect(() =>
      validatePatchSet({
        summary: '',
        files: [{ path: 'big.txt', op: 'create', content: 'x'.repeat(MAX_FILE_BYTES + 1) }],
      }),
    ).toThrow();
  });
  it('rejects duplicate paths', () => {
    expect(() =>
      validatePatchSet({
        summary: '',
        files: [
          { path: 'a.txt', op: 'create', content: '1' },
          { path: 'a.txt', op: 'update', content: '2' },
        ],
      }),
    ).toThrow();
  });
  it('rejects delete ops (not representable)', () => {
    expect(() =>
      validatePatchSet({
        summary: '',
        files: [{ path: 'a.txt', op: 'delete' as any, content: '' }],
      }),
    ).toThrow();
  });
  it('detects conflict when update target changed', () => {
    const tree: TreeEntry[] = [{ path: 'a.txt', sha: 'sha2', type: 'blob' }];
    const snapshot = new Map([['a.txt', 'sha1']]);
    expect(() =>
      assertPatchTargets(
        { summary: '', files: [{ path: 'a.txt', op: 'update', content: 'x' }] },
        tree,
        snapshot,
      ),
    ).toThrow(/GITHUB_CONFLICT|changed during generation/);
  });
  it('detects conflict when create target exists', () => {
    const tree: TreeEntry[] = [{ path: 'a.txt', sha: 'sha1', type: 'blob' }];
    expect(() =>
      assertPatchTargets(
        { summary: '', files: [{ path: 'a.txt', op: 'create', content: 'x' }] },
        tree,
        new Map(),
      ),
    ).toThrow();
  });
  it('superset assertion catches missing base files', () => {
    const base: TreeEntry[] = [
      { path: 'a.txt', sha: '1', type: 'blob' },
      { path: 'b.txt', sha: '2', type: 'blob' },
    ];
    const newTree: TreeEntry[] = [{ path: 'a.txt', sha: '1', type: 'blob' }];
    expect(() => assertSuperset(base, newTree)).toThrow();
  });
  it('superset assertion passes when all base files present', () => {
    const base: TreeEntry[] = [{ path: 'a.txt', sha: '1', type: 'blob' }];
    const newTree: TreeEntry[] = [
      { path: 'a.txt', sha: '1', type: 'blob' },
      { path: 'b.txt', sha: '2', type: 'blob' },
    ];
    expect(() => assertSuperset(base, newTree)).not.toThrow();
  });
});

describe('token encryption', () => {
  it('roundtrips', () => {
    const enc = encryptToken('ghp_secret123');
    expect(enc).not.toContain('secret');
    expect(decryptToken(enc)).toBe('ghp_secret123');
  });
  it('produces different ciphertexts (random IV)', () => {
    expect(encryptToken('same')).not.toBe(encryptToken('same'));
  });
});

describe('quota day key', () => {
  it('is UTC YYYY-MM-DD', () => {
    const k = dayKey(Date.UTC(2026, 9, 22, 23, 59));
    expect(k).toBe('2026-10-22');
  });
});

describe('parsePatch', () => {
  it('parses clean JSON', () => {
    const p = parsePatch(JSON.stringify({ summary: 'hi', files: [{ path: 'a.txt', op: 'create', content: 'x' }] }));
    expect(p.files).toHaveLength(1);
    expect(p.summary).toBe('hi');
  });
  it('strips markdown fences', () => {
    const raw = '```json\n{"summary":"x","files":[{"path":"a.txt","op":"create","content":"y"}]}\n```';
    expect(parsePatch(raw).files).toHaveLength(1);
  });
  it('rejects empty files', () => {
    expect(() => parsePatch(JSON.stringify({ summary: 'x', files: [] }))).toThrow();
  });
});

describe('install state signing', () => {
  it('roundtrips', () => {
    const token = signInstallState('user-123');
    const state = verifyInstallState(token);
    expect(state.userId).toBe('user-123');
    expect(state.expiry).toBeGreaterThan(Date.now());
  });
  it('rejects tampered state', () => {
    const token = signInstallState('user-123');
    expect(() => verifyInstallState(token + 'x')).toThrow();
  });
});

describe('refundsQuota', () => {
  it('refunds system-caused failures', () => {
    expect(refundsQuota('AI_PROVIDER_ERROR')).toBe(true);
    expect(refundsQuota('CONFIG_ERROR')).toBe(true);
    expect(refundsQuota('INTERNAL')).toBe(true);
  });
  it('does not refund user/race failures', () => {
    expect(refundsQuota('GITHUB_CONFLICT')).toBe(false);
    expect(refundsQuota('QUOTA_EXCEEDED')).toBe(false);
    expect(refundsQuota('AI_OUTPUT_INVALID')).toBe(false);
  });
});

describe('multi-problem reporting', () => {
  it('collects every policy violation instead of only the first', () => {
    let caught: any;
    try {
      validatePatchSet({
        summary: '',
        files: [
          { path: '/abs.txt', op: 'create', content: 'x' },
          { path: 'a.txt', op: 'delete' as any, content: 'x' },
          { path: 'a.txt', op: 'create', content: 'x' },
          { path: '.env', op: 'create', content: 'x' },
        ],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('AI_OUTPUT_INVALID');
    const codes = caught.issues.map((i: any) => i.code);
    expect(codes).toContain('ABSOLUTE_PATH');
    expect(codes).toContain('ILLEGAL_OP');
    expect(codes).toContain('DUPLICATE_PATH');
    expect(codes).toContain('SECRET_FILE');
    expect(caught.issues.length).toBeGreaterThanOrEqual(4);
  });

  it('collects every target conflict at once', () => {
    const tree: TreeEntry[] = [{ path: 'a.txt', sha: 'sha1', type: 'blob' }];
    const snapshot = new Map([['a.txt', 'sha0']]);
    let caught: any;
    try {
      assertPatchTargets(
        {
          summary: '',
          files: [
            { path: 'a.txt', op: 'create', content: 'x' },
            { path: 'b.txt', op: 'update', content: 'x' },
          ],
        },
        tree,
        snapshot,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe('GITHUB_CONFLICT');
    expect(caught.issues.length).toBe(2);
  });

  it('reports all problems in a bad model output at once', () => {
    let caught: any;
    try {
      parsePatch(
        JSON.stringify({
          summary: 'x',
          files: [
            { path: '/etc/passwd', op: 'create', content: 'x' },
            { path: 'dup.txt', op: 'create', content: 'x' },
            { path: 'dup.txt', op: 'update', content: 'y' },
          ],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught.code).toBe('AI_OUTPUT_INVALID');
    const codes = caught.issues.map((i: any) => i.code);
    expect(codes).toContain('ABSOLUTE_PATH');
    expect(codes).toContain('DUPLICATE_PATH');
    expect(caught.issues.length).toBe(2);
  });
});

describe('model provider chain', () => {
  it('classifies provider failures by status', () => {
    expect(classifyProviderStatus(404)).toBe('model_not_found');
    expect(classifyProviderStatus(401)).toBe('auth');
    expect(classifyProviderStatus(403)).toBe('auth');
    expect(classifyProviderStatus(429)).toBe('rate_limited');
    expect(classifyProviderStatus(502)).toBe('transient');
    expect(classifyProviderStatus(503)).toBe('transient');
    expect(classifyProviderStatus(400)).toBe('invalid_request');
  });

  it('tries the primary model, its fallbacks, then the other provider', () => {
    const prev = {
      openrouter: process.env.OPENROUTER_API_KEY,
      groq: process.env.GROQ_API_KEY,
      model: process.env.OPENMI_MODEL,
      fallbacks: process.env.OPENMI_MODEL_FALLBACKS,
      groqModel: process.env.GROQ_MODEL,
    };
    process.env.OPENROUTER_API_KEY = 'k';
    process.env.GROQ_API_KEY = 'g';
    process.env.OPENMI_MODEL = 'primary/model';
    process.env.OPENMI_MODEL_FALLBACKS = 'second/model,primary/model';
    process.env.GROQ_MODEL = 'fallback/provider-model';
    try {
      const chain = buildProviderChain();
      expect(chain.map((c) => `${c.provider}:${c.model}`)).toEqual([
        'openrouter:primary/model',
        'openrouter:second/model',
        'groq:fallback/provider-model',
      ]);
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore('OPENROUTER_API_KEY', prev.openrouter);
      restore('GROQ_API_KEY', prev.groq);
      restore('OPENMI_MODEL', prev.model);
      restore('OPENMI_MODEL_FALLBACKS', prev.fallbacks);
      restore('GROQ_MODEL', prev.groqModel);
    }
  });

  it('uses a Groq model that still exists', () => {
    // llama-3.3-70b-versatile was retired for free/Developer tiers in 2026.
    expect(env.groqModel()).not.toBe('llama-3.3-70b-versatile');
  });
});

describe('runner budget', () => {
  it('never exceeds the function max duration', () => {
    const prevMax = process.env.MAX_FUNCTION_DURATION;
    const prevBudget = process.env.RUN_BUDGET_SECONDS;
    process.env.MAX_FUNCTION_DURATION = '60';
    try {
      // A budget above maxDuration would be killed by the platform before the
      // lease is released, leaving the task stuck until the cron sweep.
      process.env.RUN_BUDGET_SECONDS = '240';
      expect(env.runBudgetSeconds()).toBe(50);
      process.env.RUN_BUDGET_SECONDS = '30';
      expect(env.runBudgetSeconds()).toBe(30);
      delete process.env.RUN_BUDGET_SECONDS;
      expect(env.runBudgetSeconds()).toBe(50);
    } finally {
      if (prevMax === undefined) delete process.env.MAX_FUNCTION_DURATION;
      else process.env.MAX_FUNCTION_DURATION = prevMax;
      if (prevBudget === undefined) delete process.env.RUN_BUDGET_SECONDS;
      else process.env.RUN_BUDGET_SECONDS = prevBudget;
    }
  });
});

describe('configuration errors', () => {
  it('reports every missing Firebase key at once', async () => {
    const prev = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY,
    };
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    try {
      let caught: any;
      try {
        firebaseApp();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught.code).toBe('CONFIG_ERROR');
      const codes = caught.issues.map((i: any) => i.code);
      expect(codes).toContain('MISSING_FIREBASE_PROJECT_ID');
      expect(codes).toContain('MISSING_FIREBASE_CLIENT_EMAIL');
      expect(codes).toContain('MISSING_FIREBASE_PRIVATE_KEY');
      expect(caught.issues.length).toBe(3);
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore('FIREBASE_PROJECT_ID', prev.projectId);
      restore('FIREBASE_CLIENT_EMAIL', prev.clientEmail);
      restore('FIREBASE_PRIVATE_KEY', prev.privateKey);
    }
  });

  it('rejects a private key that is not a PEM block', async () => {
    const prev = process.env.FIREBASE_PRIVATE_KEY;
    process.env.FIREBASE_PRIVATE_KEY = 'not-a-pem-block';
    try {
      let caught: any;
      try {
        firebaseApp();
      } catch (e) {
        caught = e;
      }
      expect(caught.code).toBe('CONFIG_ERROR');
      expect(caught.issues.map((i: any) => i.code)).toContain('INVALID_FIREBASE_PRIVATE_KEY');
    } finally {
      if (prev === undefined) delete process.env.FIREBASE_PRIVATE_KEY;
      else process.env.FIREBASE_PRIVATE_KEY = prev;
    }
  });
});

describe('setup checklist catalogue', () => {
  it('describes every variable with a purpose and instructions', () => {
    expect(CONFIG_CATALOGUE.length).toBeGreaterThan(10);
    for (const entry of CONFIG_CATALOGUE) {
      expect(entry.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(entry.purpose.length).toBeGreaterThan(10);
      expect(entry.howToSet.length).toBeGreaterThan(10);
      expect(['required', 'recommended', 'optional']).toContain(entry.group);
    }
  });

  it('never exposes a value, only presence', () => {
    const checks = configChecks();
    for (const c of checks) {
      expect(typeof c.present).toBe('boolean');
      expect(Object.keys(c)).not.toContain('value');
      // The serialised form must not contain the secret itself.
      expect(JSON.stringify(c)).not.toContain('internal-token-123456789012345678901234567890');
    }
  });

  it('reports the required variables that are not set', () => {
    const prev = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY,
      encKey: process.env.GITHUB_TOKEN_ENC_KEY,
      internal: process.env.INTERNAL_TASK_TOKEN,
      cron: process.env.CRON_SECRET,
      apiKey: process.env.FIREBASE_API_KEY,
    };
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.GITHUB_TOKEN_ENC_KEY;
    delete process.env.INTERNAL_TASK_TOKEN;
    delete process.env.CRON_SECRET;
    delete process.env.FIREBASE_API_KEY;
    try {
      const missing = missingConfigKeys();
      expect(missing).toContain('FIREBASE_PROJECT_ID');
      expect(missing).toContain('FIREBASE_API_KEY');
      expect(missing).toContain('FIREBASE_CLIENT_EMAIL');
      expect(missing).toContain('FIREBASE_PRIVATE_KEY');
      expect(missing).toContain('GITHUB_TOKEN_ENC_KEY');
      expect(missing).toContain('INTERNAL_TASK_TOKEN');
      expect(missing).toContain('CRON_SECRET');
      // The catalogue and the missing list cannot drift apart.
      const required = configChecks().filter((c) => c.required);
      expect(missing.sort()).toEqual(required.filter((c) => !c.present).map((c) => c.name).sort());
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore('FIREBASE_PROJECT_ID', prev.projectId);
      restore('FIREBASE_CLIENT_EMAIL', prev.clientEmail);
      restore('FIREBASE_PRIVATE_KEY', prev.privateKey);
      restore('GITHUB_TOKEN_ENC_KEY', prev.encKey);
      restore('INTERNAL_TASK_TOKEN', prev.internal);
      restore('CRON_SECRET', prev.cron);
      restore('FIREBASE_API_KEY', prev.apiKey);
    }
  });

  it('marks a variable with a default as not set when it is only defaulted', () => {
    const prev = process.env.OPENMI_MODEL;
    delete process.env.OPENMI_MODEL;
    try {
      const check = configChecks().find((c) => c.name === 'OPENMI_MODEL')!;
      expect(check.present).toBe(false);
      expect(check.defaultValue).toBe('qwen/qwen3-coder-next');
    } finally {
      if (prev === undefined) delete process.env.OPENMI_MODEL;
      else process.env.OPENMI_MODEL = prev;
    }
  });
});

describe('step runner', () => {
  it('runs steps in order', async () => {
    const order: string[] = [];
    const steps: Step<unknown>[] = [
      { name: 'a', run: async () => { order.push('a'); return 1; } },
      { name: 'b', run: async () => { order.push('b'); return 2; } },
    ];
    const results = await runSteps(steps, 10);
    expect(order).toEqual(['a', 'b']);
    expect(results).toEqual([1, 2]);
  });

  it('retries transient failures then succeeds', async () => {
    let attempts = 0;
    const steps: Step<unknown>[] = [
      {
        name: 'flaky',
        run: async () => {
          attempts++;
          if (attempts < 2) throw new Error('transient');
          return 'ok';
        },
      },
    ];
    const results = await runSteps(steps, 10);
    expect(attempts).toBe(2);
    expect(results[0]).toBe('ok');
  });

  it('does not retry non-retryable AppError', async () => {
    let attempts = 0;
    const { AppError } = await import('../server/errors.js');
    const steps: Step<unknown>[] = [
      {
        name: 'bad',
        run: async () => {
          attempts++;
          throw new AppError('AI_OUTPUT_INVALID', 'bad output', { retryable: false });
        },
      },
    ];
    await expect(runSteps(steps, 10)).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('throws DeadlineExceededError when budget exhausted', async () => {
    const steps: Step<unknown>[] = [
      { name: 'slow', run: async () => { await new Promise((r) => setTimeout(r, 200)); return 'x'; } },
    ];
    await expect(runSteps(steps, 0)).rejects.toBeInstanceOf(DeadlineExceededError);
  });
});
