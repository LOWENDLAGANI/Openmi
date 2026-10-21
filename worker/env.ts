import type { TaskWorkflowParams } from './workflows/types';
import { AppError } from './lib/errors';

/**
 * Worker bindings and configuration. Secrets are optional at the type level so
 * a half-configured deployment can still boot and report `SETUP_REQUIRED`
 * instead of crashing at import time.
 *
 * Server identity for Firestore: either a Firebase service account
 * (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY) OR keyless Workload Identity
 * Federation (the GCP_* vars below). Never both required.
 */
export interface Env {
  // Platform bindings. Present on Cloudflare; absent on Vercel, where static
  // assets are served by the platform and tasks run through HTTP dispatch.
  ASSETS?: Fetcher;
  TASK_WORKFLOW?: Workflow<TaskWorkflowParams>;

  // Platform runner configuration (Vercel / self-hosted Node)
  APP_ORIGIN?: string;
  INTERNAL_DISPATCH_URL?: string;
  INTERNAL_TASK_TOKEN?: string;
  CRON_SECRET?: string;
  RUN_BUDGET_SECONDS?: string;

  // Public config (wrangler vars / Vercel env). Handed to the browser via
  // /api/config so the Firebase client SDK can initialize.
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  FIREBASE_AUTH_DOMAIN?: string;
  FIREBASE_APP_ID?: string;
  OPENMI_MODEL: string;
  DAILY_TASK_LIMIT: string;
  MAX_CONCURRENT_TASKS: string;
  DEFAULT_COMMIT_MODE: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_SLUG?: string;

  // Server identity option A: Firebase service account (local dev fallback).
  // Generate at: Project settings -> Service accounts -> Generate new private key.
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;

  // Server identity option B (preferred, keyless): Workload Identity Federation.
  // Vercel mints short-lived OIDC tokens; Google trusts them via a WIF pool.
  // No private key is ever created or stored. All values are non-secret config.
  GCP_PROJECT_NUMBER?: string;
  GCP_WORKLOAD_IDENTITY_POOL_ID?: string;
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID?: string;
  // Optional: if set, the federated identity impersonates this service account.
  // If omitted, grant Firestore IAM roles directly to the federated principal
  // (no service account object exists at all).
  GCP_SERVICE_ACCOUNT_EMAIL?: string;

  // Secrets (wrangler secret / Vercel env / .dev.vars)
  GITHUB_TOKEN_ENC_KEY?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_STATE_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  GROQ_API_KEY?: string;
}

const REQUIRED_SECRETS = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_API_KEY',
  'GITHUB_TOKEN_ENC_KEY',
  'OPENROUTER_API_KEY',
] as const;
export type ConfigKey = (typeof REQUIRED_SECRETS)[number];

export interface GithubAppConfig {
  enabled: boolean;
  appId: string | null;
  /** Preferred JWT issuer; falls back to the app id. */
  clientId: string | null;
  slug: string | null;
  privateKeyPem: string | null;
  webhookSecret: string | null;
  stateSecret: string | null;
}

export interface GcpWifConfig {
  projectNumber: string;
  poolId: string;
  providerId: string;
  serviceAccountEmail: string | null;
  /** `//iam.googleapis.com/...` form used in the ExternalAccountClient config. */
  audience: string;
  /** `https://iam.googleapis.com/...` form requested as the OIDC token audience. */
  tokenAudience: string;
}

export interface FirebaseClientConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

export interface AppConfig {
  firebaseProjectId: string;
  firebaseApiKey: string;
  firebaseAuthDomain: string;
  firebaseAppId: string;
  firebaseClientEmail: string | null;
  firebasePrivateKey: string | null;
  gcpWif: GcpWifConfig | null;
  githubTokenEncKey: string;
  openRouterApiKey: string;
  groqApiKey: string | null;
  model: string;
  dailyTaskLimit: number;
  maxConcurrentTasks: number;
  defaultCommitMode: 'direct' | 'pull_request';
  githubApp: GithubAppConfig;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function trimmed(value: string | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

/** PEMs pasted into dashboards often keep literal `\n` sequences. */
function normalizePem(value: string | null): string | null {
  return value ? value.replace(/\\n/g, '\n') : null;
}

export function missingConfig(env: Env): ConfigKey[] {
  return REQUIRED_SECRETS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.trim() === '';
  });
}

export function resolveGithubAppConfig(env: Env): GithubAppConfig {
  const appId = trimmed(env.GITHUB_APP_ID);
  const privateKeyPem = normalizePem(trimmed(env.GITHUB_APP_PRIVATE_KEY));
  const slug = trimmed(env.GITHUB_APP_SLUG);
  const webhookSecret = trimmed(env.GITHUB_APP_WEBHOOK_SECRET);
  return {
    enabled: Boolean(appId && privateKeyPem && slug),
    appId,
    clientId: trimmed(env.GITHUB_APP_CLIENT_ID) ?? appId,
    slug,
    privateKeyPem,
    webhookSecret,
    // Reuses the webhook secret when no dedicated state secret is set.
    stateSecret: trimmed(env.GITHUB_APP_STATE_SECRET) ?? webhookSecret,
  };
}

function resolveGcpWif(env: Env): GcpWifConfig | null {
  const projectNumber = trimmed(env.GCP_PROJECT_NUMBER);
  const poolId = trimmed(env.GCP_WORKLOAD_IDENTITY_POOL_ID);
  const providerId = trimmed(env.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID);
  if (!projectNumber || !poolId || !providerId) return null;
  const path = `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
  return {
    projectNumber,
    poolId,
    providerId,
    serviceAccountEmail: trimmed(env.GCP_SERVICE_ACCOUNT_EMAIL),
    audience: `//iam.googleapis.com/${path}`,
    tokenAudience: `https://iam.googleapis.com/${path}`,
  };
}

/** Public client config handed to the browser. Never includes secrets. */
export function firebaseClientConfig(env: Env): FirebaseClientConfig {
  const projectId = (env.FIREBASE_PROJECT_ID ?? '').trim();
  return {
    apiKey: (env.FIREBASE_API_KEY ?? '').trim(),
    authDomain:
      trimmed(env.FIREBASE_AUTH_DOMAIN) ?? `${projectId}.firebaseapp.com`,
    projectId,
    appId: trimmed(env.FIREBASE_APP_ID) ?? '',
    // Project number is not needed for auth; leave empty when unset.
    messagingSenderId: '',
  };
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
  const projectId = env.FIREBASE_PROJECT_ID.trim();
  return {
    firebaseProjectId: projectId,
    firebaseApiKey: env.FIREBASE_API_KEY.trim(),
    firebaseAuthDomain:
      trimmed(env.FIREBASE_AUTH_DOMAIN) ?? `${projectId}.firebaseapp.com`,
    firebaseAppId: trimmed(env.FIREBASE_APP_ID) ?? '',
    firebaseClientEmail: trimmed(env.FIREBASE_CLIENT_EMAIL),
    firebasePrivateKey: normalizePem(trimmed(env.FIREBASE_PRIVATE_KEY)),
    gcpWif: resolveGcpWif(env),
    githubTokenEncKey: env.GITHUB_TOKEN_ENC_KEY as string,
    openRouterApiKey: env.OPENROUTER_API_KEY as string,
    groqApiKey: env.GROQ_API_KEY?.trim() || null,
    model: env.OPENMI_MODEL?.trim() || 'qwen/qwen3-coder',
    dailyTaskLimit: positiveInt(env.DAILY_TASK_LIMIT, 5),
    maxConcurrentTasks: positiveInt(env.MAX_CONCURRENT_TASKS, 2),
    defaultCommitMode: commitMode,
    githubApp: resolveGithubAppConfig(env),
  };
}
