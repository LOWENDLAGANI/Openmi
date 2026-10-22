import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from './env.js';
import { AppError, issue, summarizeIssues } from './errors.js';
import type { Issue } from '../shared/types.js';

let app: App | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

// Collect every configuration problem at once, so a misconfigured deployment
// says "these three keys are wrong" instead of failing on the first one.
function firebaseConfigIssues(): Issue[] {
  const issues: Issue[] = [];
  const projectId = env.firebaseProjectId();
  const clientEmail = env.firebaseClientEmail();
  const privateKey = env.firebasePrivateKey();
  if (!projectId) {
    issues.push(
      issue('MISSING_FIREBASE_PROJECT_ID', 'FIREBASE_PROJECT_ID is not set', {
        field: 'FIREBASE_PROJECT_ID',
      }),
    );
  }
  if (!clientEmail) {
    issues.push(
      issue('MISSING_FIREBASE_CLIENT_EMAIL', 'FIREBASE_CLIENT_EMAIL is not set', {
        field: 'FIREBASE_CLIENT_EMAIL',
      }),
    );
  }
  if (!privateKey) {
    issues.push(
      issue('MISSING_FIREBASE_PRIVATE_KEY', 'FIREBASE_PRIVATE_KEY is not set', {
        field: 'FIREBASE_PRIVATE_KEY',
      }),
    );
  } else if (!env.firebasePrivateKeyValid()) {
    // A PEM that lost its newlines (or a pasted JSON blob) fails deep inside
    // OpenSSL with "DECODER routines::unsupported". Say what is actually wrong.
    issues.push(
      issue(
        'INVALID_FIREBASE_PRIVATE_KEY',
        'FIREBASE_PRIVATE_KEY is not a PEM private key block (expected -----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----)',
        { field: 'FIREBASE_PRIVATE_KEY' },
      ),
    );
  }
  return issues;
}

export function firebaseApp(): App {
  if (app) return app;
  const issues = firebaseConfigIssues();
  if (issues.length) {
    throw new AppError('CONFIG_ERROR', summarizeIssues(issues), {
      details: { issues },
      retryable: false,
    });
  }
  const projectId = env.firebaseProjectId()!;
  const clientEmail = env.firebaseClientEmail()!;
  const privateKey = env.firebasePrivateKey()!;
  if (getApps().length > 0) {
    app = getApps()[0];
  } else {
    try {
      app = initializeApp({
        credential: cert({ projectId, clientEmail, privateKey }),
        projectId,
      });
    } catch (e: any) {
      // The key exists and looks like a PEM but the SDK still refuses it.
      const detail = issue(
        'FIREBASE_CREDENTIAL_REJECTED',
        `Firebase rejected the service account credential: ${e?.message ?? e}`,
        { field: 'FIREBASE_PRIVATE_KEY' },
      );
      throw new AppError('CONFIG_ERROR', detail.message, {
        details: { issues: [detail] },
        retryable: false,
      });
    }
  }
  return app;
}

export function firebaseAuth(): Auth {
  if (auth) return auth;
  auth = getAuth(firebaseApp());
  return auth;
}

export function firestore(): Firestore {
  if (db) return db;
  db = getFirestore(firebaseApp());
  return db;
}

export const collections = {
  profiles: () => firestore().collection('profiles'),
  githubCredentials: () => firestore().collection('github_credentials'),
  githubInstallations: () => firestore().collection('github_installations'),
  githubInstallationTokens: () => firestore().collection('github_installation_tokens'),
  projects: () => firestore().collection('projects'),
  tasks: () => firestore().collection('tasks'),
  usageDaily: () => firestore().collection('usage_daily'),
  taskEvents: (taskId: string) =>
    firestore().collection('tasks').doc(taskId).collection('events'),
};
