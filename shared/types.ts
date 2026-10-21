// Wire types shared between the API and the SPA.

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'conflict';

export type CommitMode = 'direct' | 'pull_request';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'QUOTA_EXCEEDED'
  | 'TOO_MANY_RUNNING_TASKS'
  | 'GITHUB_NOT_CONNECTED'
  | 'GITHUB_CONFLICT'
  | 'GITHUB_AUTH_EXPIRED'
  | 'GITHUB_UNAVAILABLE'
  | 'GITHUB_NOT_FOUND'
  | 'AI_PROVIDER_ERROR'
  | 'AI_OUTPUT_INVALID'
  | 'CONFIG_ERROR'
  | 'INTERNAL'
  | 'INVALID_INPUT';

export interface PatchFile {
  path: string;
  /** 'create' | 'update' — deletions are never representable. */
  op: 'create' | 'update';
  content: string;
}

export interface PatchSet {
  files: PatchFile[];
  summary: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type:
    | 'created'
    | 'claimed'
    | 'base_pinned'
    | 'context_read'
    | 'patch_generated'
    | 'committed'
    | 'succeeded'
    | 'failed'
    | 'conflict'
    | 'redeployed'
    | 'info';
  message?: string;
  data?: Record<string, unknown>;
  createdAt: number;
}

export interface Task {
  id: string;
  ownerId: string;
  projectId: string;
  prompt: string;
  status: TaskStatus;
  commitMode: CommitMode;
  baseSha?: string;
  baseTreeSha?: string;
  branch?: string;
  patch?: PatchSet;
  commitSha?: string;
  commitUrl?: string;
  pullRequestUrl?: string;
  errorCode?: ErrorCode;
  errorMessage?: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
  leaseExpiresAt?: number;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  ownerId: string;
  repoFullName: string;
  defaultBranch: string;
  commitMode: CommitMode;
  installationId?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Profile {
  uid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
  githubLinked: boolean;
  githubAppInstalled: boolean;
  createdAt: number;
}

export interface QuotaInfo {
  dailyLimit: number;
  usedToday: number;
  remainingToday: number;
  concurrentLimit: number;
  runningNow: number;
  tokensUsedToday?: number;
}
export interface RepoFile {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
}

export interface PublicConfig {
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId?: string;
  };
  githubAppInstallUrl?: string;
  githubAppConfigured: boolean;
  defaultCommitMode: CommitMode;
  dailyTaskLimit: number;
  maxConcurrentTasks: number;
  model: string;
}

export interface HealthResponse {
  ok: boolean;
  time: number;
  missingConfig: string[];
  firebaseConfigured: boolean;
  githubAppConfigured: boolean;
  openRouterConfigured: boolean;
}
