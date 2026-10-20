import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../worker/env';
import type { TaskWorkflowParams } from '../worker/workflows/types';

const mocks = vi.hoisted(() => ({
  leaseTask: vi.fn(),
  setTaskBase: vi.fn(),
  addTaskEvent: vi.fn(),
  completeTask: vi.fn(),
  failTask: vi.fn(),
  getTaskRow: vi.fn(),
  saveTaskPatch: vi.fn(),
  getProject: vi.fn(),
  getGithubCredential: vi.fn(),
  refundTaskQuota: vi.fn(),
  getBranchHead: vi.fn(),
  getCommitTreeSha: vi.fn(),
  getBlobText: vi.fn(),
  getRepoTree: vi.fn(),
  commitPatchSet: vi.fn(),
  resolveGithubAuth: vi.fn(),
  hasGithubAuth: vi.fn(),
  generatePatch: vi.fn(),
  selectContextFiles: vi.fn(),
  truncateFileContent: vi.fn(),
}));

vi.mock('../worker/db/tasks', () => ({
  leaseTask: mocks.leaseTask,
  setTaskBase: mocks.setTaskBase,
  addTaskEvent: mocks.addTaskEvent,
  completeTask: mocks.completeTask,
  failTask: mocks.failTask,
  getTaskRow: mocks.getTaskRow,
  saveTaskPatch: mocks.saveTaskPatch,
}));

vi.mock('../worker/db/projects', () => ({ getProject: mocks.getProject }));

vi.mock('../worker/db/users', () => ({
  refundTaskQuota: mocks.refundTaskQuota,
}));

vi.mock('../worker/github/client', () => ({
  createOctokit: () => ({}),
}));

vi.mock('../worker/github/repo', () => ({
  getBranchHead: mocks.getBranchHead,
  getCommitTreeSha: mocks.getCommitTreeSha,
  getBlobText: mocks.getBlobText,
  getRepoTree: mocks.getRepoTree,
}));

vi.mock('../worker/github/commit', () => ({ commitPatchSet: mocks.commitPatchSet }));
vi.mock('../worker/github/auth', () => ({
  resolveGithubAuth: mocks.resolveGithubAuth,
  hasGithubAuth: mocks.hasGithubAuth,
}));
vi.mock('../worker/agent/generate', () => ({ generatePatch: mocks.generatePatch }));
vi.mock('../worker/agent/context', () => ({
  selectContextFiles: mocks.selectContextFiles,
  truncateFileContent: mocks.truncateFileContent,
}));

import { AppError } from '../worker/lib/errors';
import { TaskWorkflow } from '../worker/workflows/task-workflow';

const env = { OPENMI_MODEL: 'test-model' } as unknown as Env;
const payload: TaskWorkflowParams = {
  taskId: 'aaaaaaaa-1111-4111-8111-111111111111',
  userId: 'bbbbbbbb-2222-4222-8222-222222222222',
  projectId: 'cccccccc-3333-4333-8333-333333333333',
};

const taskRow = {
  id: payload.taskId,
  project_id: payload.projectId,
  owner_id: payload.userId,
  prompt: 'Add a share button to the header',
  status: 'running',
  commit_sha: null,
  commit_url: null,
  branch: null,
  files_changed: 0,
  patch: null,
};

interface RowState {
  id: string;
  project_id: string;
  owner_id: string;
  prompt: string;
  status: string;
  commit_sha: string | null;
  commit_url: string | null;
  branch: string | null;
  files_changed: number;
  patch: unknown;
  summary?: string | null;
  model?: string | null;
}

let rowState: RowState;

const project = {
  id: payload.projectId,
  owner_id: payload.userId,
  name: 'demo',
  repo_full_name: 'octocat/demo',
  default_branch: 'main',
  commit_mode: 'direct',
  created_at: '',
  updated_at: '',
};

/** Minimal WorkflowStep: runs every step body inline, records names. */
function createStep() {
  const names: string[] = [];
  const step = {
    do: async (
      name: string,
      configOrFn: unknown,
      maybeFn?: () => Promise<unknown>,
    ): Promise<unknown> => {
      names.push(name);
      const fn = typeof configOrFn === 'function' ? configOrFn : maybeFn;
      if (!fn) throw new Error(`Step ${name} has no body`);
      return fn();
    },
    sleep: async () => undefined,
  };
  return { step, names };
}

async function runWorkflow() {
  const workflow = new TaskWorkflow({} as ExecutionContext, env);
  const { step, names } = createStep();
  const event = {
    payload,
    timestamp: new Date(),
    instanceId: 'instance-1',
  } as unknown as WorkflowEvent<TaskWorkflowParams>;

  let error: unknown;
  try {
    await workflow.run(event, step as unknown as WorkflowStep);
  } catch (caught) {
    error = caught;
  }
  return { error, names };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.setTaskBase.mockResolvedValue(undefined);
  mocks.leaseTask.mockResolvedValue({
    row: { ...taskRow, status: 'running', lease_expires_at: null },
    claimed: true,
  });
  mocks.getProject.mockResolvedValue(project);
  mocks.hasGithubAuth.mockResolvedValue(true);
  mocks.resolveGithubAuth.mockResolvedValue({
    kind: 'github_app',
    token: 'ghs_installation_token',
    login: 'octocat',
    installationId: 42,
  });
  mocks.getBranchHead.mockResolvedValue('base-sha');
  mocks.getCommitTreeSha.mockResolvedValue('tree-sha');
  mocks.getRepoTree.mockResolvedValue({
    entries: [{ path: 'src/App.tsx', sha: 'blob-app', size: 100 }],
    truncated: false,
  });
  mocks.selectContextFiles.mockReturnValue({
    entries: [{ path: 'src/App.tsx', sha: 'blob-app', size: 100 }],
    omitted: 0,
  });
  mocks.getBlobText.mockResolvedValue('export const App = () => null;');
  mocks.truncateFileContent.mockImplementation((content: string) => ({
    content,
    truncated: false,
  }));
  mocks.generatePatch.mockResolvedValue({
    summary: 'Adds a share button.',
    files: [
      {
        path: 'src/App.tsx',
        operation: 'update',
        content: 'export const App = () => <button>Share</button>;',
        baseBlobSha: 'blob-app',
      },
    ],
    model: 'test-model',
    promptTokens: 100,
    completionTokens: 50,
  });
  mocks.commitPatchSet.mockResolvedValue({
    commitSha: 'commit-sha',
    commitUrl: 'https://github.com/octocat/demo/commit/commit-sha',
    branch: 'main',
    filesChanged: 1,
    mode: 'direct',
  });
  // Model the task row as a tiny in-memory store so resume guards and commit
  // replay exercise the real persistence flow instead of a fixed fixture.
  rowState = { ...taskRow, patch: null };
  mocks.getTaskRow.mockImplementation(async () => ({ ...rowState }));
  mocks.saveTaskPatch.mockImplementation(
    async (_env: unknown, _id: string, input: { patch: unknown; summary: string; model: string; filesChanged: number }) => {
      rowState.patch = input.patch;
      rowState.summary = input.summary;
      rowState.model = input.model;
      rowState.files_changed = input.filesChanged;
    },
  );
  mocks.completeTask.mockImplementation(
    async (
      _env: unknown,
      _id: string,
      input: { commitSha: string; commitUrl: string; branch: string; filesChanged: number },
    ) => {
      rowState.status = 'succeeded';
      rowState.commit_sha = input.commitSha;
      rowState.commit_url = input.commitUrl;
      rowState.branch = input.branch;
      rowState.files_changed = input.filesChanged;
    },
  );
  mocks.addTaskEvent.mockResolvedValue(undefined);
  mocks.failTask.mockResolvedValue(undefined);
  mocks.refundTaskQuota.mockResolvedValue(undefined);
});

describe('TaskWorkflow happy path', () => {
  it('runs every durable step in order and commits once', async () => {
    const { error, names } = await runWorkflow();

    expect(error).toBeUndefined();
    expect(names).toEqual([
      'claim task',
      'resolve base commit',
      'read repository context',
      'generate patch set',
      'commit to github',
      'finalize task',
    ]);

    expect(mocks.saveTaskPatch).toHaveBeenCalledTimes(1);
    expect(mocks.commitPatchSet).toHaveBeenCalledTimes(1);

    const commitArgs = mocks.commitPatchSet.mock.calls[0]?.[0];
    expect(commitArgs).toMatchObject({
      repoFullName: 'octocat/demo',
      baseSha: 'base-sha',
      branch: 'main',
      mode: 'direct',
      taskId: payload.taskId,
    });
    expect(commitArgs.files[0]).toMatchObject({
      path: 'src/App.tsx',
      baseBlobSha: 'blob-app',
    });

    expect(mocks.completeTask).toHaveBeenCalledWith(
      env,
      payload.taskId,
      expect.objectContaining({ commitSha: 'commit-sha', branch: 'main' }),
    );
    expect(mocks.failTask).not.toHaveBeenCalled();
    expect(mocks.refundTaskQuota).not.toHaveBeenCalled();
  });

  it('skips work entirely for an already-finished task', async () => {
    mocks.setTaskBase.mockResolvedValue(undefined);
  mocks.leaseTask.mockResolvedValue({
    row: { ...taskRow, status: 'succeeded' },
    claimed: true,
  });

    const { error, names } = await runWorkflow();

    expect(error).toBeUndefined();
    expect(names).toEqual(['claim task']);
    expect(mocks.commitPatchSet).not.toHaveBeenCalled();
  });

  it('never commits twice when the task already has a commit', async () => {
    rowState.patch = {
      summary: 'done',
      files: [],
    };
    rowState.commit_sha = 'existing-sha';
    rowState.commit_url = 'https://github.com/octocat/demo/commit/existing-sha';
    rowState.branch = 'main';
    rowState.files_changed = 1;
    mocks.getTaskRow.mockResolvedValue({
      ...taskRow,
      patch: { summary: 'done', files: [] },
      commit_sha: 'existing-sha',
      commit_url: 'https://github.com/octocat/demo/commit/existing-sha',
      branch: 'main',
      files_changed: 1,
    });

    await runWorkflow();

    expect(mocks.commitPatchSet).not.toHaveBeenCalled();
    // A resumed commit must not duplicate the timeline entry either.
    expect(mocks.addTaskEvent).not.toHaveBeenCalledWith(
      env,
      payload.taskId,
      expect.stringContaining('Committed'),
    );
  });

  it('does nothing when another invocation holds the lease', async () => {
    mocks.leaseTask.mockResolvedValue({
      row: { ...taskRow, status: 'running' },
      claimed: false,
    });

    const { error, names } = await runWorkflow();

    expect(error).toBeUndefined();
    expect(names).toEqual(['claim task']);
    expect(mocks.getProject).not.toHaveBeenCalled();
    expect(mocks.generatePatch).not.toHaveBeenCalled();
    expect(mocks.commitPatchSet).not.toHaveBeenCalled();
  });
});

describe('TaskWorkflow failure handling', () => {
  it('refunds the quota when the AI provider is unavailable', async () => {
    mocks.generatePatch.mockRejectedValue(
      new AppError('AI_UNAVAILABLE', 'The coding model is unavailable right now'),
    );

    const { error, names } = await runWorkflow();

    expect(error).toBeInstanceOf(Error);
    expect(names).toContain('record failure');
    expect(mocks.failTask).toHaveBeenCalledWith(
      env,
      payload.taskId,
      expect.objectContaining({ code: 'AI_UNAVAILABLE' }),
    );
    expect(mocks.refundTaskQuota).toHaveBeenCalledWith(env, payload.userId);
    expect(mocks.commitPatchSet).not.toHaveBeenCalled();
  });

  it('does not refund when the model output was rejected by policy', async () => {
    mocks.generatePatch.mockRejectedValue(
      new AppError('PATCH_REJECTED', 'Protected path cannot be modified by the agent: .github/x'),
    );

    const { error } = await runWorkflow();

    expect(error).toBeInstanceOf(Error);
    expect(mocks.failTask).toHaveBeenCalledWith(
      env,
      payload.taskId,
      expect.objectContaining({ code: 'PATCH_REJECTED' }),
    );
    expect(mocks.refundTaskQuota).not.toHaveBeenCalled();
  });

  it('preserves the conflict code when a human edited the file first', async () => {
    mocks.commitPatchSet.mockRejectedValue(
      new AppError('GITHUB_CONFLICT', '"src/App.tsx" changed on GitHub while the agent was working.'),
    );

    const { error } = await runWorkflow();

    expect(error).toBeInstanceOf(Error);
    expect(mocks.failTask).toHaveBeenCalledWith(
      env,
      payload.taskId,
      expect.objectContaining({ code: 'GITHUB_CONFLICT' }),
    );
    // A conflict is the user's repository moving, not a system failure.
    expect(mocks.refundTaskQuota).not.toHaveBeenCalled();
  });

  it('refuses to start when GitHub is not connected', async () => {
    mocks.hasGithubAuth.mockResolvedValue(false);

    const { error, names } = await runWorkflow();

    expect(error).toBeInstanceOf(Error);
    expect(names).toEqual(['claim task', 'record failure']);
    expect(mocks.failTask).toHaveBeenCalledWith(
      env,
      payload.taskId,
      expect.objectContaining({ code: 'GITHUB_NOT_CONNECTED' }),
    );
    expect(mocks.getBranchHead).not.toHaveBeenCalled();
  });
});
