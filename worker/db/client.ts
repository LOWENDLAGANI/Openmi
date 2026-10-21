import { cert, getApps, initializeApp, type App, type Credential } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { ExternalAccountClient } from 'google-auth-library';
import { loadConfig, type Env, type GcpWifConfig } from '../env.js';
import { AppError } from '../lib/errors.js';

/**
 * Firebase Admin (service-role) Firestore client. Never expose the server
 * identity to the browser; every query in this codebase is additionally scoped
 * by owner id.
 *
 * Server identity — two modes, neither requires a long-lived secret in code:
 *
 *  1. Keyless (preferred on Vercel): Workload Identity Federation. Vercel mints
 *     a short-lived OIDC token at runtime; Google's STS exchanges it for a
 *     Google access token. No private key is ever created or stored. Configure
 *     GCP_PROJECT_NUMBER + GCP_WORKLOAD_IDENTITY_POOL_ID +
 *     GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID (optionally
 *     GCP_SERVICE_ACCOUNT_EMAIL to impersonate).
 *  2. Service account (local-dev fallback): FIREBASE_CLIENT_EMAIL +
 *     FIREBASE_PRIVATE_KEY.
 *
 * firebase-admin requires a Node runtime (Vercel / self-hosted Node). The
 * Cloudflare Workers edge path is not supported.
 */
interface FirebaseBundle {
  app: App;
  db: Firestore;
}

const bundles = new Map<string, FirebaseBundle>();

/** @vercel/oidc only resolves on Vercel; import lazily so local dev still boots. */
async function vercelSubjectToken(audience: string): Promise<string> {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  return getVercelOidcToken({ audience });
}

function wifCredential(wif: GcpWifConfig): Credential {
  const config = {
    type: 'external_account',
    audience: wif.audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    ...(wif.serviceAccountEmail
      ? {
          service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${wif.serviceAccountEmail}:generateAccessToken`,
        }
      : {}),
    subject_token_supplier: {
      getSubjectToken: () => vercelSubjectToken(wif.tokenAudience),
    },
  };
  // The subject-token-supplier form is typed narrowly in some releases; the
  // runtime accepts it, so cast through `never`.
  const client = ExternalAccountClient.fromJSON(config as never);
  if (!client) {
    throw new AppError('CONFIG_ERROR', 'Failed to build Workload Identity Federation client', {
      status: 503,
    });
  }

  return {
    getAccessToken: async () => {
      const result = await client.getAccessToken();
      if (!result.token) {
        throw new AppError('INTERNAL', 'Workload Identity Federation returned no access token', {
          retryable: true,
        });
      }
      // firebase-admin's AccessToken shape varies by release; include both
      // field names so the credential works across versions.
      return {
        access_token: result.token,
        expires_in: 3600,
        accessToken: result.token,
        expiresIn: 3600,
      } as never;
    },
  } as Credential;
}

export function firebase(env: Env): FirebaseBundle {
  const config = loadConfig(env);
  const cached = bundles.get(config.firebaseProjectId);
  if (cached) return cached;

  let credential: Credential;
  if (config.firebasePrivateKey && config.firebaseClientEmail) {
    credential = cert({
      projectId: config.firebaseProjectId,
      clientEmail: config.firebaseClientEmail,
      privateKey: config.firebasePrivateKey,
    });
  } else if (config.gcpWif) {
    credential = wifCredential(config.gcpWif);
  } else {
    throw new AppError(
      'CONFIG_ERROR',
      'No server identity for Firestore. Set either a service account ' +
        '(FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY) or keyless Workload Identity Federation ' +
        '(GCP_PROJECT_NUMBER + GCP_WORKLOAD_IDENTITY_POOL_ID + GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID).',
      { status: 503 },
    );
  }

  const existing = getApps().find((app) => app.name === config.firebaseProjectId);
  const app = existing ?? initializeApp({ credential }, config.firebaseProjectId);
  const bundle: FirebaseBundle = { app, db: getFirestore(app) };
  bundles.set(config.firebaseProjectId, bundle);
  return bundle;
}

/** Firestore (service role). All writes go through here. */
export function firestore(env: Env): Firestore {
  return firebase(env).db;
}
