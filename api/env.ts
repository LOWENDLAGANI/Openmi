import type { Env } from '../worker/env';

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
    SUPABASE_URL: value('SUPABASE_URL'),
    SUPABASE_ANON_KEY: value('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: optional('SUPABASE_SERVICE_ROLE_KEY'),
    SUPABASE_JWT_SECRET: optional('SUPABASE_JWT_SECRET'),
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
