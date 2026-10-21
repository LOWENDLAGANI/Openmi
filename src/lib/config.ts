import type { FirebaseClientConfigView } from '@shared/types';

export interface RuntimeConfig {
  firebase: FirebaseClientConfigView;
  version: string;
  ready: boolean;
  missing: string[];
  githubApp: {
    enabled: boolean;
    slug: string | null;
  };
  appOrigin: string | null;
}

let cached: Promise<RuntimeConfig> | null = null;

/**
 * Public runtime config. The Firebase web config (apiKey, authDomain,
 * projectId) is designed to be public; Firestore security rules protect the
 * data. Secrets (service account) never leave the server.
 */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;
  cached = (async () => {
    const response = await fetch('/api/config', { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Config endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as {
      firebase?: Partial<FirebaseClientConfigView>;
      version?: string;
      ready?: boolean;
      missing?: string[];
      githubApp?: { enabled?: boolean; slug?: string | null };
      appOrigin?: string;
    };
    return {
      firebase: {
        apiKey: body.firebase?.apiKey ?? '',
        authDomain: body.firebase?.authDomain ?? '',
        projectId: body.firebase?.projectId ?? '',
        appId: body.firebase?.appId ?? '',
        messagingSenderId: body.firebase?.messagingSenderId ?? '',
      },
      version: body.version ?? '0.0.0',
      ready: Boolean(body.ready),
      missing: Array.isArray(body.missing) ? body.missing : [],
      githubApp: {
        enabled: Boolean(body.githubApp?.enabled),
        slug: body.githubApp?.slug ?? null,
      },
      appOrigin: typeof body.appOrigin === 'string' && body.appOrigin ? body.appOrigin : null,
    };
  })();
  return cached;
}
