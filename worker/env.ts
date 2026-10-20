import type { TaskWorkflowParams } from './workflows/types';
import { AppError } from './lib/errors';

/**
 * Worker bindings and configuration. Secrets are optional at the type level so
 * a half-configured deployment can still boot and report `SETUP_REQUIRED`
 * instead of crashing at import time.
 */
export interface Env {
  ASSETS: Fetcher;
  TASK_WORKFLOW: Workflow<TaskWorkflowParams>;

  // Public config (wrangler vars)
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  OPENMI_MODEL: string;
  DAILY_TASK_LIMIT: string;
  MAX_CONCURRENT_TASKS: string;
  DEFAULT_COMMIT_MODE: string;

  // Secrets (wrangler secret / .dev.vars)
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_JWT_SECRET?: string;
  GITHUB_TOKEN_ENC_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GROQ_API_KEY?: string;
}

const REQUIRED_SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GITHUB_TOKEN_ENC_KEY',
  'OPENROUTER_API_KEY',
] as const;

export type ConfigKey = (typeof REQUIRED_SECRETS)[number];

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  githubTokenEncKey: string;
  openRouterApiKey: string;
  groqApiKey: string | null;
  model: string;
  dailyTaskLimit: number;
  maxConcurrentTasks: number;
  defaultCommitMode: 'direct' | 'pull_request';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function missingConfig(env: Env): ConfigKey[] {
  return REQUIRED_SECRETS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * Reads validated config or throws a typed `CONFIG_ERROR`.
 * Called per request for a clear error instead of a cryptic downstream failure.
 */
export function loadConfig(env: Env): AppConfig {
  const missing = missingConfig(env);
  if (missing.length > 0) {
    throw new AppError('CONFIG_ERROR', `Missing configuration: ${missing.join(', ')}`, {
      status: 503,
    });
  }

  const commitMode = env.DEFAULT_COMMIT_MODE === 'pull_request' ? 'pull_request' : 'direct';

  return {
    supabaseUrl: env.SUPABASE_URL.replace(/\/+$/, ''),
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY as string,
    githubTokenEncKey: env.GITHUB_TOKEN_ENC_KEY as string,
    openRouterApiKey: env.OPENROUTER_API_KEY as string,
    groqApiKey: env.GROQ_API_KEY?.trim() || null,
    model: env.OPENMI_MODEL?.trim() || 'qwen/qwen3-coder',
    dailyTaskLimit: positiveInt(env.DAILY_TASK_LIMIT, 5),
    maxConcurrentTasks: positiveInt(env.MAX_CONCURRENT_TASKS, 2),
    defaultCommitMode: commitMode,
  };
}
