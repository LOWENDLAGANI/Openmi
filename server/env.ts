// Centralised environment access. Every secret is read through here so the
// health endpoint can report which keys are missing (never their values).

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

  // Encryption
  githubTokenEncKey: () => str('GITHUB_TOKEN_ENC_KEY'),

  // Models
  openRouterApiKey: () => str('OPENROUTER_API_KEY'),
  groqApiKey: () => str('GROQ_API_KEY'),
  model: () => str('OPENMI_MODEL') ?? 'qwen/qwen3-coder',

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
  runBudgetSeconds: () => int('RUN_BUDGET_SECONDS', 240),

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

export function missingConfigKeys(): string[] {
  const required: Array<[string, string | undefined]> = [
    ['FIREBASE_PROJECT_ID', env.firebaseProjectId()],
    ['FIREBASE_API_KEY', env.firebaseApiKey()],
    ['FIREBASE_CLIENT_EMAIL', env.firebaseClientEmail()],
    ['FIREBASE_PRIVATE_KEY', env.firebasePrivateKey()],
    ['GITHUB_TOKEN_ENC_KEY', env.githubTokenEncKey()],
    ['INTERNAL_TASK_TOKEN', env.internalTaskToken()],
    ['CRON_SECRET', env.cronSecret()],
  ];
  return required.filter(([, v]) => v === undefined).map(([k]) => k);
}

export function firebaseConfigured(): boolean {
  return (
    env.firebaseProjectId() !== undefined &&
    env.firebaseClientEmail() !== undefined &&
    env.firebasePrivateKey() !== undefined
  );
}

export function githubAppConfigured(): boolean {
  return (
    env.githubAppId() !== undefined &&
    env.githubAppPrivateKey() !== undefined &&
    env.githubAppWebhookSecret() !== undefined
  );
}
