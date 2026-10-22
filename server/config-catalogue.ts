// The single catalogue of environment variables: what each one is for, where
// to set it, and whether it is currently set. The SPA renders this as a setup
// checklist, so the metadata must stay free of secret values — only names,
// purposes and instructions cross the wire.

export type ConfigGroup = 'required' | 'recommended' | 'optional';

export interface ConfigEntry {
  name: string;
  group: ConfigGroup;
  /** True when the value must never be shown or logged. */
  secret: boolean;
  purpose: string;
  /** Concrete instruction: where to set it and what to do afterwards. */
  howToSet: string;
  example?: string;
  /** The value used when the variable is not set (shown as "default"). */
  defaultValue?: string;
  /** Whether the variable is set right now. Never reads a value into the result. */
  isSet: () => boolean;
}

const VERCEL =
  'Vercel → Project → Settings → Environment Variables (add to Production and Preview), then redeploy.';
const LOCAL = 'add it to .env.local, then restart the dev server';

// Presence only: the catalogue never reads a value into the result.
const raw = (name: string) => () => {
  const v = process.env[name];
  return v !== undefined && v !== '';
};

export const CONFIG_CATALOGUE: ConfigEntry[] = [
  {
    name: 'FIREBASE_PROJECT_ID',
    group: 'required',
    secret: false,
    purpose: 'Firebase project id. Also identifies the project to the browser SDK.',
    howToSet: `Firebase console → Project settings → General → Project ID. ${VERCEL}`,
    example: 'my-app-dev',
    isSet: raw('FIREBASE_PROJECT_ID'),
  },
  {
    name: 'FIREBASE_API_KEY',
    group: 'required',
    secret: false,
    purpose: 'Public web API key. Handed to the browser through /api/config; safe to expose.',
    howToSet: `Firebase console → Project settings → General → Web API Key. ${VERCEL}`,
    example: 'AIzaSy…',
    isSet: raw('FIREBASE_API_KEY'),
  },
  {
    name: 'FIREBASE_CLIENT_EMAIL',
    group: 'required',
    secret: true,
    purpose:
      'Service account email. The server signs in to Firestore and verifies ID tokens with it.',
    howToSet: `Firebase console → Project settings → Service accounts → Generate new private key; copy "client_email" from the downloaded JSON. ${VERCEL}`,
    example: 'firebase-adminsdk-xxxx@my-app-dev.iam.gserviceaccount.com',
    isSet: raw('FIREBASE_CLIENT_EMAIL'),
  },
  {
    name: 'FIREBASE_PRIVATE_KEY',
    group: 'required',
    secret: true,
    purpose:
      'The service account private key (PEM). Used server-side only; never sent to the browser.',
    howToSet: `Same service-account JSON → copy "private_key" (keep the BEGIN/END lines). On Vercel paste it as ONE line with the newlines written as \\n. ${VERCEL}`,
    example: '-----BEGIN PRIVATE KEY-----\\nMIIEv…\\n-----END PRIVATE KEY-----\\n',
    isSet: raw('FIREBASE_PRIVATE_KEY'),
  },
  {
    name: 'GITHUB_TOKEN_ENC_KEY',
    group: 'required',
    secret: true,
    purpose:
      'AES-256-GCM key that encrypts stored GitHub tokens at rest. Rotating it invalidates every stored token.',
    howToSet: `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))". ${VERCEL}`,
    example: '0a1B2c3D…=',
    isSet: raw('GITHUB_TOKEN_ENC_KEY'),
  },
  {
    name: 'INTERNAL_TASK_TOKEN',
    group: 'required',
    secret: true,
    purpose:
      'Shared secret the runner uses to dispatch itself. The runner endpoint accepts it and nothing else.',
    howToSet: `Any random string of 32+ characters: openssl rand -hex 32. ${VERCEL}`,
    example: '3f9c…',
    isSet: raw('INTERNAL_TASK_TOKEN'),
  },
  {
    name: 'CRON_SECRET',
    group: 'required',
    secret: true,
    purpose:
      'Bearer token Vercel Cron sends to /api/cron/recover, which re-dispatches tasks whose runner died.',
    howToSet: `Any random string: openssl rand -hex 32. ${VERCEL}`,
    example: '9ab4…',
    isSet: raw('CRON_SECRET'),
  },

  {
    name: 'OPENROUTER_API_KEY',
    group: 'recommended',
    secret: true,
    purpose:
      'Primary model provider. Without it the agent cannot generate a patch, so no task can run.',
    howToSet: `Create a key at openrouter.ai/keys, then ${VERCEL}`,
    example: 'sk-or-v1-…',
    isSet: raw('OPENROUTER_API_KEY'),
  },
  {
    name: 'GROQ_API_KEY',
    group: 'recommended',
    secret: true,
    purpose:
      'Fallback model provider, used when the OpenRouter models fail or are unavailable.',
    howToSet: `Create a key at console.groq.com/keys, then ${VERCEL}`,
    example: 'gsk_…',
    isSet: raw('GROQ_API_KEY'),
  },
  {
    name: 'GITHUB_APP_ID',
    group: 'recommended',
    secret: false,
    purpose:
      'GitHub App id. Enables short-lived installation tokens (per-repo, revocable) instead of a personal OAuth token.',
    howToSet: `GitHub → Settings → Developer settings → GitHub Apps → your app → App ID. ${VERCEL}`,
    example: '123456',
    isSet: raw('GITHUB_APP_ID'),
  },
  {
    name: 'GITHUB_APP_PRIVATE_KEY',
    group: 'recommended',
    secret: true,
    purpose: 'PKCS#8 PEM that signs the GitHub App JWT used to mint installation tokens.',
    howToSet: `Download the App private key from GitHub, then convert it: openssl pkcs8 -topk8 -nocrypt -in app.pem -out app-pkcs8.pem. Paste as ONE line with \\n escapes. ${VERCEL}`,
    example: '-----BEGIN PRIVATE KEY-----\\n…',
    isSet: raw('GITHUB_APP_PRIVATE_KEY'),
  },
  {
    name: 'GITHUB_APP_CLIENT_ID',
    group: 'recommended',
    secret: false,
    purpose: 'Preferred JWT issuer for GitHub App requests.',
    howToSet: `Same GitHub App page → Client ID. ${VERCEL}`,
    example: 'Iv1.0123456789abcdef',
    defaultValue: 'the app id',
    isSet: raw('GITHUB_APP_CLIENT_ID'),
  },
  {
    name: 'GITHUB_APP_SLUG',
    group: 'recommended',
    secret: false,
    purpose: 'Slug of the GitHub App, used to build the "Install GitHub App" link.',
    howToSet: `Same GitHub App page → the URL slug, e.g. "openmi". ${VERCEL}`,
    example: 'openmi',
    isSet: raw('GITHUB_APP_SLUG'),
  },
  {
    name: 'GITHUB_APP_WEBHOOK_SECRET',
    group: 'recommended',
    secret: true,
    purpose:
      'Verifies the X-Hub-Signature-256 header on install webhooks, and signs the install state.',
    howToSet: `Set a secret on the App's Webhook page, then ${VERCEL}`,
    example: 'a random string',
    isSet: raw('GITHUB_APP_WEBHOOK_SECRET'),
  },

  {
    name: 'FIREBASE_AUTH_DOMAIN',
    group: 'optional',
    secret: false,
    purpose: 'Auth domain for the browser SDK.',
    howToSet: `Firebase console → Project settings → General → Authorized domains. ${LOCAL}`,
    example: 'my-app-dev.firebaseapp.com',
    defaultValue: '<project-id>.firebaseapp.com',
    isSet: raw('FIREBASE_AUTH_DOMAIN'),
  },
  {
    name: 'FIREBASE_APP_ID',
    group: 'optional',
    secret: false,
    purpose: 'Web app id from the Firebase console. Only needed by some auth flows.',
    howToSet: `Firebase console → Project settings → General → Your apps → Web app → App ID. ${LOCAL}`,
    example: '1:1234567890:web:abcdef',
    isSet: raw('FIREBASE_APP_ID'),
  },
  {
    name: 'GITHUB_APP_STATE_SECRET',
    group: 'optional',
    secret: true,
    purpose: 'HMAC key that signs the install-state token.',
    howToSet: `Leave unset unless you want a separate key. ${LOCAL}`,
    example: 'a random string',
    defaultValue: 'the webhook secret',
    isSet: raw('GITHUB_APP_STATE_SECRET'),
  },
  {
    name: 'OPENMI_MODEL',
    group: 'optional',
    secret: false,
    purpose: 'Primary model slug on OpenRouter. Older slugs get retired, so keep it current.',
    howToSet: `Leave unset for the default. ${LOCAL}`,
    example: 'qwen/qwen3-coder-next',
    defaultValue: 'qwen/qwen3-coder-next',
    isSet: raw('OPENMI_MODEL'),
  },
  {
    name: 'OPENMI_MODEL_FALLBACKS',
    group: 'optional',
    secret: false,
    purpose:
      'Comma-separated slugs tried, in order, when the primary model is gone or unavailable.',
    howToSet: `Leave unset for the default chain. ${LOCAL}`,
    example: 'qwen/qwen3-coder,qwen/qwen3-coder-flash',
    defaultValue: 'qwen/qwen3-coder,qwen/qwen3-coder-flash',
    isSet: raw('OPENMI_MODEL_FALLBACKS'),
  },
  {
    name: 'GROQ_MODEL',
    group: 'optional',
    secret: false,
    purpose: 'Model slug used on Groq.',
    howToSet: `Leave unset for the default. ${LOCAL}`,
    example: 'openai/gpt-oss-120b',
    defaultValue: 'openai/gpt-oss-120b',
    isSet: raw('GROQ_MODEL'),
  },
  {
    name: 'DAILY_TASK_LIMIT',
    group: 'optional',
    secret: false,
    purpose: 'Tasks each user may start per UTC day.',
    howToSet: `Leave unset for the default. ${LOCAL}`,
    example: '5',
    defaultValue: '5',
    isSet: raw('DAILY_TASK_LIMIT'),
  },
  {
    name: 'MAX_CONCURRENT_TASKS',
    group: 'optional',
    secret: false,
    purpose: 'How many tasks a user may have in flight at once.',
    howToSet: `Leave unset for the default. ${LOCAL}`,
    example: '2',
    defaultValue: '2',
    isSet: raw('MAX_CONCURRENT_TASKS'),
  },
  {
    name: 'DEFAULT_COMMIT_MODE',
    group: 'optional',
    secret: false,
    purpose:
      'Whether new projects commit straight to the branch (direct) or open a pull request.',
    howToSet: `Leave unset for "direct". ${LOCAL}`,
    example: 'direct',
    defaultValue: 'direct',
    isSet: raw('DEFAULT_COMMIT_MODE'),
  },
  {
    name: 'APP_ORIGIN',
    group: 'optional',
    secret: false,
    purpose:
      'Base URL the runner dispatches itself to. Inferred from the Vercel production URL when unset.',
    howToSet: `Set it to https://<your-domain> in production, http://localhost:8787 locally. ${LOCAL}`,
    example: 'https://openmi.example.com',
    defaultValue: 'inferred from the Vercel production URL',
    isSet: raw('APP_ORIGIN'),
  },
  {
    name: 'INTERNAL_DISPATCH_URL',
    group: 'optional',
    secret: false,
    purpose:
      'Dispatch to a specific deployment instead of APP_ORIGIN. Needed when preview deployments sit behind Vercel Authentication.',
    howToSet: `Leave unset unless previews are protected. ${LOCAL}`,
    example: 'https://openmi-git-abc123.vercel.app',
    isSet: raw('INTERNAL_DISPATCH_URL'),
  },
  {
    name: 'RUN_BUDGET_SECONDS',
    group: 'optional',
    secret: false,
    purpose:
      'Wall-clock budget for one runner invocation. Clamped below MAX_FUNCTION_DURATION so a run never outlives the function.',
    howToSet: `Leave unset for the default. ${LOCAL}`,
    example: '50',
    defaultValue: '50',
    isSet: raw('RUN_BUDGET_SECONDS'),
  },
  {
    name: 'MAX_FUNCTION_DURATION',
    group: 'optional',
    secret: false,
    purpose:
      'Hard ceiling of the serverless function in seconds. Must match maxDuration in api/[[...route]].ts.',
    howToSet: `Leave unset for the default. ${LOCAL}`,
    example: '60',
    defaultValue: '60',
    isSet: raw('MAX_FUNCTION_DURATION'),
  },
];

export interface ConfigCheck {
  name: string;
  group: ConfigGroup;
  required: boolean;
  present: boolean;
  secret: boolean;
  purpose: string;
  howToSet: string;
  example?: string;
  defaultValue?: string;
}

// Names, purposes and presence only — never values.
export function configChecks(): ConfigCheck[] {
  return CONFIG_CATALOGUE.map((e) => ({
    name: e.name,
    group: e.group,
    required: e.group === 'required',
    present: e.isSet(),
    secret: e.secret,
    purpose: e.purpose,
    howToSet: e.howToSet,
    example: e.example,
    defaultValue: e.defaultValue,
  }));
}
