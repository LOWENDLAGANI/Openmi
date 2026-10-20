import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signInstallState, verifyInstallState } from '../worker/github/state';
import { parseInstallationEvent, verifyWebhookSignature } from '../worker/github/webhook';

const SECRET = 'test-state-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('install state', () => {
  it('round-trips a user id', async () => {
    const state = await signInstallState(SECRET, USER_ID);
    await expect(verifyInstallState(SECRET, state)).resolves.toEqual({ userId: USER_ID });
  });

  it('rejects a tampered payload', async () => {
    const state = await signInstallState(SECRET, USER_ID);
    const [payload, signature] = state.split('.') as [string, string];
    const forgedPayload = Buffer.from(
      JSON.stringify({ u: 'attacker', e: Date.now() + 60_000, n: 'x' }),
    ).toString('base64url');

    await expect(verifyInstallState(SECRET, `${forgedPayload}.${signature}`)).rejects.toMatchObject(
      { code: 'BAD_REQUEST' },
    );
    expect(payload).not.toBe(forgedPayload);
  });

  it('rejects a signature from another secret', async () => {
    const state = await signInstallState('other-secret', USER_ID);
    await expect(verifyInstallState(SECRET, state)).rejects.toThrowError(/signature is invalid/i);
  });

  it('rejects expired state', async () => {
    const now = Date.now();
    const state = await signInstallState(SECRET, USER_ID, { now, ttlMs: 1000 });
    await expect(verifyInstallState(SECRET, state, now + 5000)).rejects.toThrowError(/expired/i);
  });

  it('rejects malformed state', async () => {
    await expect(verifyInstallState(SECRET, 'nope')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(verifyInstallState(SECRET, 'a.b.c')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('webhook signature', () => {
  const secret = 'webhook-secret';
  const body = JSON.stringify({ action: 'created', installation: { id: 5 } });

  function sign(payload: string, key = secret): string {
    return `sha256=${createHmac('sha256', key).update(payload).digest('hex')}`;
  }

  it('accepts a valid HMAC over the raw body', async () => {
    const bytes = new TextEncoder().encode(body);
    await expect(
      verifyWebhookSignature(bytes.buffer as ArrayBuffer, sign(body), secret),
    ).resolves.toBe(true);
  });

  it('rejects a wrong secret, a wrong body, and a missing header', async () => {
    const bytes = new TextEncoder().encode(body);
    await expect(
      verifyWebhookSignature(bytes.buffer as ArrayBuffer, sign(body, 'other'), secret),
    ).resolves.toBe(false);

    const tampered = new TextEncoder().encode(`${body} `);
    await expect(
      verifyWebhookSignature(tampered.buffer as ArrayBuffer, sign(body), secret),
    ).resolves.toBe(false);

    await expect(
      verifyWebhookSignature(bytes.buffer as ArrayBuffer, null, secret),
    ).resolves.toBe(false);
  });

  it('rejects malformed signature headers', async () => {
    const bytes = new TextEncoder().encode(body);
    for (const header of ['sha1=abc', 'sha256=xyz', 'sha256=' + 'a'.repeat(63)]) {
      await expect(
        verifyWebhookSignature(bytes.buffer as ArrayBuffer, header, secret),
      ).resolves.toBe(false);
    }
  });
});

describe('parseInstallationEvent', () => {
  const base = {
    installation: {
      id: 77,
      app_id: 123456,
      account: { login: 'acme', type: 'Organization' },
      repository_selection: 'selected',
      suspended_at: null,
    },
  };

  it('parses handled actions', () => {
    for (const action of ['created', 'deleted', 'suspend', 'unsuspend']) {
      expect(parseInstallationEvent({ ...base, action })).toMatchObject({
        action,
        installationId: 77,
        appId: 123456,
        login: 'acme',
        repositorySelection: 'selected',
      });
    }
  });

  it('reflects suspension state', () => {
    const parsed = parseInstallationEvent({
      action: 'suspend',
      installation: { ...base.installation, suspended_at: '2026-10-20T00:00:00Z' },
    });
    expect(parsed?.suspended).toBe(true);
  });

  it('ignores unrelated or malformed payloads', () => {
    expect(parseInstallationEvent({ action: 'edited', ...base })).toBeNull();
    expect(parseInstallationEvent({ action: 'created' })).toBeNull();
    expect(parseInstallationEvent(null)).toBeNull();
    expect(parseInstallationEvent({ action: 'created', installation: { account: {} } })).toBeNull();
  });
});
