import type {
  CreateTaskResponse,
  GithubConnectionView,
  GithubRepoView,
  MeView,
  ProjectView,
  TaskDetail,
  TaskSummary,
} from '@shared/types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export interface ApiClient {
  me(): Promise<MeView>;
  linkGithub(providerToken: string): Promise<GithubConnectionView>;
  startGithubAppInstall(): Promise<string>;
  repos(): Promise<GithubRepoView[]>;
  projects(): Promise<ProjectView[]>;
  createProject(input: {
    repoFullName: string;
    name?: string;
    commitMode?: 'direct' | 'pull_request';
  }): Promise<ProjectView>;
  createTask(input: { projectId: string; prompt: string }): Promise<CreateTaskResponse>;
  task(id: string): Promise<TaskDetail>;
  projectTasks(projectId: string): Promise<TaskSummary[]>;
}

/**
 * `getToken` returns the current Firebase ID token, forcing a refresh when
 * asked. The API server verifies it with firebase-admin.
 */
export function createApiClient(
  getToken: (forceRefresh?: boolean) => Promise<string>,
): ApiClient {
  async function authHeaders(): Promise<Record<string, string>> {
    const token = await getToken();
    if (!token) throw new ApiError('UNAUTHENTICATED', 'Please sign in again', 401);
    return { authorization: `Bearer ${token}` };
  }

  async function request<T>(path: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
    const headers = {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(await authHeaders()),
      ...(init.headers ?? {}),
    };
    const response = await fetch(`/api${path}`, { ...init, headers });
    // Sessions expire silently on a phone that was locked for hours.
    if (response.status === 401 && allowRetry) {
      try {
        await getToken(true);
        return request<T>(path, init, false);
      } catch {
        // refresh failed — fall through to surface the 401
      }
    }
    if (!response.ok) {
      let body: ErrorBody = {};
      try {
        body = (await response.json()) as ErrorBody;
      } catch {
        /* non-JSON error */
      }
      throw new ApiError(
        body.error?.code ?? 'INTERNAL',
        body.error?.message ?? `Request failed (${response.status})`,
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    me: () => request<MeView>('/me'),
    linkGithub: (providerToken) =>
      request<GithubConnectionView>('/github/link', {
        method: 'POST',
        body: JSON.stringify({ providerToken }),
      }),
    startGithubAppInstall: async () =>
      (await request<{ url: string }>('/github/app/install', { method: 'POST' })).url,
    repos: async () => (await request<{ repos: GithubRepoView[] }>('/github/repos')).repos,
    projects: async () => (await request<{ projects: ProjectView[] }>('/projects')).projects,
    createProject: async (input) =>
      (
        await request<{ project: ProjectView }>('/projects', {
          method: 'POST',
          body: JSON.stringify(input),
        })
      ).project,
    createTask: (input) =>
      request<CreateTaskResponse>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
    task: (id) => request<TaskDetail>(`/tasks/${encodeURIComponent(id)}`),
    projectTasks: async (projectId) =>
      (
        await request<{ tasks: TaskSummary[] }>(
          `/projects/${encodeURIComponent(projectId)}/tasks`,
        )
      ).tasks,
  };
}
