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
import { parsePatch } from '../server/agent/model.js';
import { signInstallState, verifyInstallState } from '../server/github/webhook.js';
import { refundsQuota } from '../server/errors.js';
import { runSteps, type Step } from '../server/agent/step-runner.js';
import { DeadlineExceededError } from '../server/errors.js';

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
