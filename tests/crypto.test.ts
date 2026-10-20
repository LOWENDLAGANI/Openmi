import { beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, shortId } from '../worker/lib/crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('secret envelope', () => {
  beforeAll(() => {
    expect(typeof crypto.subtle).toBe('object');
  });

  it('round-trips a GitHub token', async () => {
    const token = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';
    const payload = await encryptSecret(KEY, token);

    expect(payload.startsWith('v1.')).toBe(true);
    expect(payload).not.toContain(token);
    await expect(decryptSecret(KEY, payload)).resolves.toBe(token);
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const a = await encryptSecret(KEY, 'same-secret');
    const b = await encryptSecret(KEY, 'same-secret');
    expect(a).not.toEqual(b);
  });

  it('fails closed when the ciphertext is tampered with', async () => {
    const payload = await encryptSecret(KEY, 'gho_token');
    const parts = payload.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${(parts[2] ?? '').slice(0, -4)}AAAA`;

    await expect(decryptSecret(KEY, tampered)).rejects.toMatchObject({ code: 'GITHUB_AUTH_EXPIRED' });
  });

  it('rejects a malformed envelope and a wrong-length key', async () => {
    await expect(decryptSecret(KEY, 'nope')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    await expect(encryptSecret(shortKey, 'token')).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});

describe('shortId', () => {
  it('is prefixed and unique', () => {
    const ids = new Set(Array.from({ length: 50 }, () => shortId('task')));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^task_[0-9a-f]{12}$/);
  });
});
