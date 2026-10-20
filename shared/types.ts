/**
 * Wire contract shared by the Worker API and the SPA.
 * Keep this file dependency-free so it can be imported from any runtime.
 */

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type CommitMode = 'direct' | 'pull_request';

export type TaskEventLevel = 'info' | 'warn' | 'error';

export interface TaskEventView {
  seq: number;
  level: TaskEventLevel;
  message: string;
  createdAt: string;
}

export interface PatchFileSummary {
  path: string;
  operation: 'create' | 'update';
  reason?: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  prompt: string;
  status: TaskStatus;
  summary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  commitSha: string | null;
  commitUrl: string | null;
  branch: string | null;
  filesChanged: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskDetail extends TaskSummary {
  events: TaskEventView[];
  files: PatchFileSummary[];
}

export interface ProjectView {
  id: string;
  name: string;
  repoFullName: string;
  defaultBranch: string;
  commitMode: CommitMode;
  createdAt: string;
  lastTaskAt: string | null;
}

export interface QuotaView {
  used: number;
  limit: number;
  remaining: number;
  /** ISO timestamp of the next UTC midnight reset. */
  resetsAt: string;
}

export interface CreateTaskResponse {
  task: TaskSummary;
  quota: QuotaView;
}

export type GithubAuthKind = 'github_app' | 'oauth';

export interface GithubConnectionView {
  login: string;
  scopes: string[];
  updatedAt: string;
  kind: GithubAuthKind;
  installationId?: number;
}

export interface MeView {
  user: {
    id: string;
    email: string | null;
    login: string | null;
    avatarUrl: string | null;
  };
  quota: QuotaView;
  github: GithubConnectionView | null;
}

export interface GithubRepoView {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  updatedAt: string | null;
}

export interface ConfigStatusView {
  ok: boolean;
  version: string;
  missing: string[];
}

export interface FirebaseClientConfigView {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

export interface RuntimeConfigView {
  firebase: FirebaseClientConfigView;
  version: string;
  ready: boolean;
  missing: string[];
  githubApp: {
    enabled: boolean;
    slug: string | null;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
