import type { TaskStatus } from '../../shared/types';

/** Row shapes mirror `supabase/migrations/*.sql` exactly. */

export interface ProfileRow {
  id: string;
  github_login: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  repo_full_name: string;
  default_branch: string;
  commit_mode: 'direct' | 'pull_request';
  created_at: string;
  updated_at: string;
}

export interface GithubInstallationRow {
  installation_id: number;
  user_id: string | null;
  account_login: string;
  account_type: string | null;
  repository_selection: 'all' | 'selected';
  suspended: boolean;
  created_at: string;
  updated_at: string;
}

export interface InstallationTokenRow {
  installation_id: number;
  token_ciphertext: string;
  expires_at: string;
  updated_at: string;
}

export interface GithubCredentialRow {
  user_id: string;
  github_login: string;
  token_ciphertext: string;
  scopes: string[];
  updated_at: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  owner_id: string;
  prompt: string;
  status: TaskStatus;
  workflow_instance_id: string | null;
  base_branch: string | null;
  base_commit_sha: string | null;
  model: string | null;
  summary: string | null;
  patch: unknown | null;
  files_changed: number;
  commit_sha: string | null;
  commit_url: string | null;
  branch: string | null;
  error_code: string | null;
  error_message: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TaskEventRow {
  id: number;
  task_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  created_at: string;
}

export interface UsageRow {
  user_id: string;
  day: string;
  tasks_started: number;
  ai_calls: number;
}
