import type { Project } from '../../shared/types.js';
import { collections } from '../firebase.js';
import { randomHex } from '../crypto.js';
import { AppError } from '../errors.js';

function fromDoc(id: string, data: Record<string, any>): Project {
  return {
    id,
    ownerId: data.ownerId,
    repoFullName: data.repoFullName,
    defaultBranch: data.defaultBranch,
    commitMode: data.commitMode,
    installationId: data.installationId,
    createdAt: data.createdAt?.toMillis?.() ?? data.createdAt,
    updatedAt: data.updatedAt?.toMillis?.() ?? data.updatedAt,
  };
}

export async function listProjects(ownerId: string): Promise<Project[]> {
  const snap = await collections
    .projects()
    .where('ownerId', '==', ownerId)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map((d) => fromDoc(d.id, d.data()));
}

export async function getProject(id: string, ownerId: string): Promise<Project | undefined> {
  const snap = await collections.projects().doc(id).get();
  if (!snap.exists) return undefined;
  const p = fromDoc(id, snap.data()!);
  if (p.ownerId !== ownerId) return undefined;
  return p;
}

export async function findProjectByRepo(
  ownerId: string,
  repoFullName: string,
): Promise<Project | undefined> {
  const snap = await collections
    .projects()
    .where('ownerId', '==', ownerId)
    .where('repoFullName', '==', repoFullName)
    .limit(1)
    .get();
  if (snap.empty) return undefined;
  const d = snap.docs[0];
  return fromDoc(d.id, d.data());
}

export async function createProject(input: {
  ownerId: string;
  repoFullName: string;
  defaultBranch: string;
  commitMode: 'direct' | 'pull_request';
  installationId?: number;
}): Promise<Project> {
  const existing = await findProjectByRepo(input.ownerId, input.repoFullName);
  if (existing) return existing;
  const id = randomHex(10);
  const now = Date.now();
  await collections.projects().doc(id).set({
    ...input,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  return { id, ...input, createdAt: now, updatedAt: now };
}

export async function requireProject(id: string, ownerId: string): Promise<Project> {
  const p = await getProject(id, ownerId);
  if (!p) throw new AppError('NOT_FOUND', 'project not found');
  return p;
}
