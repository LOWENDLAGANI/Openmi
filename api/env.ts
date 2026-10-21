import type { Env } from '../worker/env.js';

/**
 * Vercel (and any Node host) provides configuration as environment variables,
 * while the shared app reads a bindings object. This adapter is the only place
 * that knows about that difference.
 */

/** The stable production URL first, then the per-deployment preview URL. */
function vercelOrigin(source: NodeJS.ProcessEnv): string | undefined {
  const host = (source.VERCEL_PROJECT_PRODUCTION_URL || source.VERCEL_URL || '').trim();
  return host ? `https://${host.replace(/^https?:\/\//, '')}` : undefined;
}

export function envFromProcess(source: NodeJS.ProcessEnv = process.env): Env {
  const value = (key: string): string => (source[key] ?? '').trim();
  const optional = (key: string): string | undefined => value(key) || undefined;
  return {
    FIREBASE_PROJECT_ID: value('FIREBASE_PROJECT_ID'),
    FIREBASE_API_KEY: value('FIREBASE_API_KEY'),
    FIREBASE_AUTH_DOMAIN: optional('FIREBASE_AUTH_DOMAIN'),
    FIREBASE_APP_ID: optional('FIREBASE_APP_ID'),
    // Service account (server-only, local-dev fallback). Leave EMPTY on Vercel
    // if using keyless Workload Identity Federation (below).
    FIREBASE_CLIENT_EMAIL: optional('FIREBASE_CLIENT_EMAIL'),
    FIREBASE_PRIVATE_KEY: optional('FIREBASE_PRIVATE_KEY'),
    // Keyless server identity (preferred on Vercel): Workload Identity Federation.
    // All values are non-secret config copied from the Google Cloud Console.
    GCP_PROJECT_NUMBER: optional('GCP_PROJECT_NUMBER'),
    GCP_WORKLOAD_IDENTITY_POOL_ID: optional('GCP_WORKLOAD_IDENTITY_POOL_ID'),
    GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: optional('GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID'),
    GCP_SERVICE_ACCOUNT_EMAIL: optional('GCP_SERVICE_ACCOUNT_EMAIL'),
    GITHUB_TOKEN_ENC_KEY: optional('GITHUB_TOKEN_ENC_KEY'),
    GITHUB_APP_ID: optional('GITHUB_APP_ID'),
    GITHUB_APP_CLIENT_ID: optional('GITHUB_APP_CLIENT_ID'),
    GITHUB_APP_SLUG: optional('GITHUB_APP_SLUG'),
    GITHUB_APP_PRIVATE_KEY: optional('GITHUB_APP_PRIVATE_KEY'),
    GITHUB_APP_WEBHOOK_SECRET: optional('GITHUB_APP_WEBHOOK_SECRET'),
    GITHUB_APP_STATE_SECRET: optional('GITHUB_APP_STATE_SECRET'),
    OPENROUTER_API_KEY: optional('OPENROUTER_API_KEY'),
    GROQ_API_KEY: optional('GROQ_API_KEY'),
    OPENMI_MODEL: value('OPENMI_MODEL') || 'qwen/qwen3-coder',
    DAILY_TASK_LIMIT: value('DAILY_TASK_LIMIT') || '5',
    MAX_CONCURRENT_TASKS: value('MAX_CONCURRENT_TASKS') || '2',
    DEFAULT_COMMIT_MODE: value('DEFAULT_COMMIT_MODE') || 'direct',
    APP_ORIGIN: optional('APP_ORIGIN') ?? vercelOrigin(source),
    INTERNAL_DISPATCH_URL: optional('INTERNAL_DISPATCH_URL'),
    INTERNAL_TASK_TOKEN: optional('INTERNAL_TASK_TOKEN'),
    CRON_SECRET: optional('CRON_SECRET'),
    RUN_BUDGET_SECONDS: optional('RUN_BUDGET_SECONDS'),
  };
}
