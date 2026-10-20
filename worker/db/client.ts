import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { loadConfig, type Env } from '../env';

/**
 * Firebase Admin (service-role) clients. Never expose the service account or
 * these clients to the browser; every query in this codebase is additionally
 * scoped by owner id.
 *
 * firebase-admin requires a Node runtime (Vercel / self-hosted Node). The
 * Cloudflare Workers deployment path is not supported with this SDK.
 */
interface FirebaseBundle {
  app: App;
  auth: Auth;
  db: Firestore;
}

const bundles = new Map<string, FirebaseBundle>();

export function firebase(env: Env): FirebaseBundle {
  const config = loadConfig(env);
  const cached = bundles.get(config.firebaseProjectId);
  if (cached) return cached;

  const existing = getApps().find((app) => app.name === config.firebaseProjectId);
  const app =
    existing ??
    initializeApp(
      {
        credential: cert({
          projectId: config.firebaseProjectId,
          clientEmail: config.firebaseClientEmail,
          privateKey: config.firebasePrivateKey,
        }),
      },
      config.firebaseProjectId,
    );

  const bundle: FirebaseBundle = {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
  };
  bundles.set(config.firebaseProjectId, bundle);
  return bundle;
}

/** Firestore (service role). All writes go through here. */
export function firestore(env: Env): Firestore {
  return firebase(env).db;
}

/** Firebase Auth admin (verifyIdToken, user lookup). */
export function firebaseAuth(env: Env): Auth {
  return firebase(env).auth;
}
