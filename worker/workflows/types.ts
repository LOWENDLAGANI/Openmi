import type { CommitMode } from '../../shared/types';

/**
 * Payload persisted with the Workflow instance. Deliberately tiny: everything
 * else (prompt, project, tokens) is re-read from Postgres inside steps so a
 * reclaimed workflow resumes from durable state rather than stale payload data.
 */
export interface TaskWorkflowParams {
  taskId: string;
  userId: string;
  projectId: string;
}

/** Snapshot of the repo pinned at the start of a task. */
export interface BaseSnapshot {
  repoFullName: string;
  owner: string;
  repo: string;
  branch: string;
  baseSha: string;
  baseTreeSha: string;
  fileCount: number;
  treeTruncated: boolean;
}

export interface ContextFile {
  path: string;
  sha: string;
  content: string;
  truncated: boolean;
}

/**
 * Everything the model needs, kept small enough to persist as workflow state.
 * The full tree is NOT carried here; steps that need it re-fetch it by sha.
 */
export interface RepoContext {
  snapshot: BaseSnapshot;
  treePaths: string[];
  files: ContextFile[];
  omittedFiles: number;
  charBudgetUsed: number;
}

export interface PatchFile {
  path: string;
  operation: 'create' | 'update';
  content: string;
  reason?: string;
  /** Blob sha of the file at the base commit, null for new files. */
  baseBlobSha: string | null;
}

export interface GeneratedPatch {
  summary: string;
  files: PatchFile[];
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface CommitResult {
  commitSha: string;
  commitUrl: string;
  branch: string;
  filesChanged: number;
  mode: CommitMode;
  pullRequestUrl?: string;
}
