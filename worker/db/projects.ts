import type { ProjectView } from '../../shared/types';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { firestore } from './client';
import type { ProjectRow, TaskRow } from './types';

function dbError(context: string, error: { message: string } | null): never {
  log.error('db.error', { context, message: error?.message });
  throw new AppError('INTERNAL', 'Database operation failed', {
    retryable: true,
    cause: error,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Firestore has no unique constraints, so (owner, repo) uniqueness is enforced
 * through an index document whose id is derived from the pair. A transaction
 * reads the index first: if it exists, the existing project is returned,
 * otherwise the project and its index are written atomically.
 *
 * Doc ids may not contain `/`, so the repo's slash is replaced with `~` (a
 * character outside the allowed repo-name charset `[A-Za-z0-9._-]`).
 */
function projectIndexId(ownerId: string, repoFullName: string): string {
  return `${ownerId}:${repoFullName.replace(/\//g, '~')}`;
}

export function toProjectView(row: ProjectRow, lastTaskAt: string | null = null): ProjectView {
  return {
    id: row.id,
    name: row.name,
    repoFullName: row.repo_full_name,
    defaultBranch: row.default_branch,
    commitMode: row.commit_mode,
    createdAt: row.created_at,
    lastTaskAt,
  };
}

export async function listProjects(env: Env, ownerId: string): Promise<ProjectView[]> {
  const db = firestore(env);
  try {
    const [projectSnap, taskSnap] = await Promise.all([
      db
        .collection('projects')
        .where('owner_id', '==', ownerId)
        .orderBy('created_at', 'desc')
        .get(),
      db
        .collection('tasks')
        .where('owner_id', '==', ownerId)
        .orderBy('created_at', 'desc')
        .limit(200)
        .get(),
    ]);
    const rows = projectSnap.docs.map((doc) => doc.data() as ProjectRow);
    const lastTaskByProject = new Map<string, string>();
    for (const doc of taskSnap.docs) {
      const task = doc.data() as Pick<TaskRow, 'project_id' | 'created_at'>;
      if (!lastTaskByProject.has(task.project_id)) {
        lastTaskByProject.set(task.project_id, task.created_at);
      }
    }
    return rows.map((row) => toProjectView(row, lastTaskByProject.get(row.id) ?? null));
  } catch (error) {
    dbError('projects.list', error as { message: string });
  }
}

export async function getProject(
  env: Env,
  ownerId: string,
  projectId: string,
): Promise<ProjectRow> {
  const db = firestore(env);
  try {
    const snap = await db.doc(`projects/${projectId}`).get();
    if (!snap.exists) throw new AppError('NOT_FOUND', 'Project not found');
    const row = snap.data() as ProjectRow;
    if (row.owner_id !== ownerId) throw new AppError('NOT_FOUND', 'Project not found');
    return row;
  } catch (error) {
    if (error instanceof AppError) throw error;
    dbError('projects.get', error as { message: string });
  }
}

export async function createProject(
  env: Env,
  input: {
    ownerId: string;
    name: string;
    repoFullName: string;
    defaultBranch: string;
    commitMode: 'direct' | 'pull_request';
  },
): Promise<ProjectRow> {
  const db = firestore(env);
  const indexRef = db.doc(`project_index/${projectIndexId(input.ownerId, input.repoFullName)}`);
  try {
    return await db.runTransaction(async (t) => {
      const indexSnap = await t.get(indexRef);
      if (indexSnap.exists) {
        const existingId = indexSnap.data()?.projectId as string;
        const projectSnap = await t.get(db.doc(`projects/${existingId}`));
        if (projectSnap.exists) {
          return projectSnap.data() as ProjectRow;
        }
        // Index points at a deleted project — fall through to recreate.
      }
      const now = nowIso();
      const projectId = crypto.randomUUID();
      const row: ProjectRow = {
        id: projectId,
        owner_id: input.ownerId,
        name: input.name,
        repo_full_name: input.repoFullName,
        default_branch: input.defaultBranch,
        commit_mode: input.commitMode,
        created_at: now,
        updated_at: now,
      };
      t.set(db.doc(`projects/${projectId}`), row);
      t.set(indexRef, {
        projectId,
        owner_id: input.ownerId,
        repo_full_name: input.repoFullName,
      });
      return row;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    dbError('projects.upsert', error as { message: string });
  }
}
