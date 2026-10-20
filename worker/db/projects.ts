import type { ProjectView } from '../../shared/types';
import type { Env } from '../env';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { db } from './client';
import type { ProjectRow, TaskRow } from './types';

function dbError(context: string, error: { message: string } | null): never {
  log.error('db.error', { context, message: error?.message });
  throw new AppError('INTERNAL', 'Database operation failed', {
    retryable: true,
    cause: error,
  });
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
  const { data, error } = await db(env)
    .from('projects')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });

  if (error) dbError('projects.list', error);
  const rows = (data ?? []) as ProjectRow[];

  const { data: taskRows, error: taskError } = await db(env)
    .from('tasks')
    .select('project_id, created_at')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (taskError) dbError('projects.last_task', taskError);

  const lastTaskByProject = new Map<string, string>();
  for (const task of (taskRows ?? []) as Pick<TaskRow, 'project_id' | 'created_at'>[]) {
    if (!lastTaskByProject.has(task.project_id)) {
      lastTaskByProject.set(task.project_id, task.created_at);
    }
  }

  return rows.map((row) => toProjectView(row, lastTaskByProject.get(row.id) ?? null));
}

export async function getProject(
  env: Env,
  ownerId: string,
  projectId: string,
): Promise<ProjectRow> {
  const { data, error } = await db(env)
    .from('projects')
    .select('*')
    .eq('id', projectId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (error) dbError('projects.get', error);
  if (!data) throw new AppError('NOT_FOUND', 'Project not found');
  return data as ProjectRow;
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
  const { data, error } = await db(env)
    .from('projects')
    .upsert(
      {
        owner_id: input.ownerId,
        name: input.name,
        repo_full_name: input.repoFullName,
        default_branch: input.defaultBranch,
        commit_mode: input.commitMode,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'owner_id,repo_full_name' },
    )
    .select('*')
    .single();

  if (error || !data) dbError('projects.upsert', error);
  return data as ProjectRow;
}
