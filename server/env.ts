// Centralised environment access. Every secret is read through here so the
// health endpoint can report which keys are missing (never their values).
import { configChecks } from './config-catalogue.js';

function str(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v;
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  // Firebase
  firebaseProjectId: () => str('FIREBASE_PROJECT_ID'),
  firebaseApiKey: () => str('FIREBASE_API_KEY'),
  firebaseAuthDomain: () =>
    str('FIREBASE_AUTH_DOMAIN') ??
    (str('FIREBASE_PROJECT_ID') ? `${str('FIREBASE_PROJECT_ID')}.firebaseapp.com` : undefined),
  firebaseAppId: () => str('FIREBASE_APP_ID'),
  firebaseClientEmail: () => str('FIREBASE_CLIENT_EMAIL'),
  firebasePrivateKey: () => {
    const v = str('FIREBASE_PRIVATE_KEY');
    if (!v) return undefined;
    // Vercel stores multi-line PEMs with literal \n escapes; unescape them.
    return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
  },
  // A private key that is present but not a PEM block fails deep inside
  // OpenSSL with an opaque "DECODER routines::unsupported". Detect it early.
  firebasePrivateKeyValid: () => {
    const k = env.firebasePrivateKey();
    return !!k && k.includes('-----BEGIN') && k.includes('-----END');
  },

  // Encryption
  githubTokenEncKey: () => str('GITHUB_TOKEN_ENC_KEY'),

  // Models
  openRouterApiKey: () => str('OPENROUTER_API_KEY'),
  groqApiKey: () => str('GROQ_API_KEY'),
  // Primary OpenRouter model. qwen/qwen3-coder-next is the current member of
  // the Qwen3-Coder family; the plain qwen/qwen3-coder slug still resolves but
  // is the older generation.
  model: () => str('OPENMI_MODEL') ?? 'qwen/qwen3-coder-next',
  // Extra OpenRouter models tried, in order, when the primary one is gone or
  // unavailable. Keeps a retired slug from breaking every task.
  modelFallbacks: () =>
    (str('OPENMI_MODEL_FALLBACKS') ?? 'qwen/qwen3-coder,qwen/qwen3-coder-flash')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  // Groq fallback model. llama-3.3-70b-versatile was retired for free and
  // Developer tiers on 2026-08-16, so it is no longer a usable default.
  groqModel: () => str('GROQ_MODEL') ?? 'openai/gpt-oss-120b',

  // Quota
  dailyTaskLimit: () => int('DAILY_TASK_LIMIT', 5),
  maxConcurrentTasks: () => int('MAX_CONCURRENT_TASKS', 2),
  defaultCommitMode: () =>
    (str('DEFAULT_COMMIT_MODE') === 'pull_request' ? 'pull_request' : 'direct') as
      | 'direct'
      | 'pull_request',

  // Runtime / dispatch
  appOrigin: () =>
    str('APP_ORIGIN') ??
    (str('VERCEL_PROJECT_PRODUCTION_URL')
      ? `https://${str('VERCEL_PROJECT_PRODUCTION_URL')}`
      : undefined),
  internalTaskToken: () => str('INTERNAL_TASK_TOKEN'),
  internalDispatchUrl: () => str('INTERNAL_DISPATCH_URL'),
  cronSecret: () => str('CRON_SECRET'),
  // Wall-clock budget for one runner invocation. The function's own
  // maxDuration (Vercel kills the invocation at that point) is the hard
  // ceiling, so the budget is clamped below it: an invocation that outlives
  // maxDuration is killed without releasing its lease, and the task then
  // hangs until the cron sweep picks it up.
  maxDurationSeconds: () => int('MAX_FUNCTION_DURATION', 60),
  runBudgetSeconds: () => {
    const max = env.maxDurationSeconds();
    const requested = int('RUN_BUDGET_SECONDS', 50);
    return Math.max(5, Math.min(requested, max - 10));
  },

  // GitHub App
  githubAppId: () => str('GITHUB_APP_ID'),
  githubAppClientId: () => str('GITHUB_APP_CLIENT_ID'),
  githubAppSlug: () => str('GITHUB_APP_SLUG'),
  githubAppPrivateKey: () => {
    const v = str('GITHUB_APP_PRIVATE_KEY');
    if (!v) return undefined;
    return v.includes('\\n') ? v.replace(/\\n/g, '\n') : v;
  },
  githubAppWebhookSecret: () => str('GITHUB_APP_WEBHOOK_SECRET'),
  githubAppStateSecret: () =>
    str('GITHUB_APP_STATE_SECRET') ?? str('GITHUB_APP_WEBHOOK_SECRET'),
};

// The required set is defined once, in the catalogue, so this list and the
// setup checklist the SPA renders can never drift apart.
export function missingConfigKeys(): string[] {
  return configChecks()
    .filter((c) => c.required && !c.present)
    .map((c) => c.name);
}

export function firebaseConfigured(): boolean {
  return (
    env.firebaseProjectId() !== undefined &&
    env.firebaseClientEmail() !== undefined &&
    env.firebasePrivateKeyValid()
  );
}

export function githubAppConfigured(): boolean {
  return (
    env.githubAppId() !== undefined &&
    env.githubAppPrivateKey() !== undefined &&
    env.githubAppWebhookSecret() !== undefined
  );
}
