export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  version: string;
  ready: boolean;
  missing: string[];
  githubApp: {
    enabled: boolean;
    slug: string | null;
  };
}

let cached: Promise<RuntimeConfig> | null = null;

/**
 * Public runtime config. The anon key is designed to be public (RLS protects
 * the data); secrets never leave the Worker.
 */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (cached) return cached;

  cached = (async () => {
    const response = await fetch('/api/config', { headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`Config endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as {
      supabaseUrl?: string;
      supabaseAnonKey?: string;
      version?: string;
      ready?: boolean;
      missing?: string[];
      githubApp?: { enabled?: boolean; slug?: string | null };
    };

    return {
      supabaseUrl: body.supabaseUrl ?? '',
      supabaseAnonKey: body.supabaseAnonKey ?? '',
      version: body.version ?? '0.0.0',
      ready: Boolean(body.ready),
      missing: Array.isArray(body.missing) ? body.missing : [],
      githubApp: {
        enabled: Boolean(body.githubApp?.enabled),
        slug: body.githubApp?.slug ?? null,
      },
    };
  })();

  return cached;
}
