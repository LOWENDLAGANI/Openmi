import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { env } from './env.js';
import { AppError } from './errors.js';

let app: App | undefined;
let auth: Auth | undefined;
let db: Firestore | undefined;

export function firebaseApp(): App {
  if (app) return app;
  const projectId = env.firebaseProjectId();
  const clientEmail = env.firebaseClientEmail();
  const privateKey = env.firebasePrivateKey();
  if (!projectId || !clientEmail || !privateKey) {
    throw new AppError('CONFIG_ERROR', 'Firebase service account is not configured');
  }
  if (getApps().length > 0) {
    app = getApps()[0];
  } else {
    app = initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
      projectId,
    });
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
