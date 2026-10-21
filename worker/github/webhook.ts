import { hexToBytes } from '../lib/base64.js';

/**
 * GitHub signs the exact raw request body with HMAC-SHA-256 and sends the
 * digest in `X-Hub-Signature-256`. Verification must happen on the raw bytes,
 * before JSON parsing, using a constant-time comparison.
 */
export async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;

  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader?.trim() ?? '');
  if (!match?.[1]) return false;

  const signature = hexToBytes(match[1]);
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  return crypto.subtle.verify('HMAC', key, signature, rawBody);
}

export type InstallationAction =
  | 'created'
  | 'deleted'
  | 'suspend'
  | 'unsuspend'
  | 'new_permissions_accepted';

export interface InstallationEvent {
  action: InstallationAction;
  installationId: number;
  appId: number | null;
  login: string;
  accountType: string | null;
  repositorySelection: 'all' | 'selected' | null;
  suspended: boolean;
}

const HANDLED_ACTIONS = new Set<string>([
  'created',
  'deleted',
  'suspend',
  'unsuspend',
  'new_permissions_accepted',
]);

interface RawInstallationPayload {
  action?: string;
  installation?: {
    id?: number;
    app_id?: number;
    account?: { login?: string; type?: string } | null;
    repository_selection?: string;
    suspended_at?: string | null;
  };
}

export function parseInstallationEvent(payload: unknown): InstallationEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as RawInstallationPayload;
  const installation = raw.installation;
  const action = raw.action;

  if (!action || !HANDLED_ACTIONS.has(action)) return null;
  if (!installation || typeof installation.id !== 'number' || !installation.account?.login) {
    return null;
  }

  return {
    action: action as InstallationAction,
    installationId: installation.id,
    appId: typeof installation.app_id === 'number' ? installation.app_id : null,
    login: installation.account.login,
    accountType: installation.account.type ?? null,
    repositorySelection:
      installation.repository_selection === 'all'
        ? 'all'
        : installation.repository_selection === 'selected'
          ? 'selected'
          : null,
    suspended: Boolean(installation.suspended_at),
  };
}
