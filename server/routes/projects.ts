import { Hono } from 'hono';
import { requireAuth, getUid } from '../auth.js';
import { listProjects, createProject, requireProject } from '../db/projects.js';
import { listTasksForProject } from '../db/tasks.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';
import { resolveGithubAuth, octokitFor } from '../github/auth.js';
import type { RepoFile } from '../../shared/types.js';

const app = new Hono();

app.use('*', requireAuth);

app.get('/projects', async (c) => {
  const uid = getUid(c);
  const projects = await listProjects(uid);
  return c.json({ projects });
});

app.post('/projects', async (c) => {
  const uid = getUid(c);
  const body = await c.req.json().catch(() => ({}));
  const repoFullName = body?.repoFullName as string | undefined;
  if (!repoFullName || !repoFullName.includes('/')) {
    throw new AppError('INVALID_INPUT', 'repoFullName must be owner/name');
  }
  // Verify the user can actually write to this repo.
  const auth = await resolveGithubAuth(uid);
  const octokit = octokitFor(auth.token);
  const [owner, repo] = repoFullName.split('/');
  let defaultBranch = 'main';
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    defaultBranch = data.default_branch;
    if (!(data.permissions as any)?.push && !(data.permissions as any)?.admin) {
      throw new AppError('FORBIDDEN', 'no push access to this repo');
    }
  } catch (e: any) {
    if (e instanceof AppError) throw e;
    if (e?.status === 404) throw new AppError('NOT_FOUND', 'repo not found or not accessible');
    throw new AppError('GITHUB_UNAVAILABLE', `repo lookup failed: ${e.message}`);
  }
  const commitMode = body?.commitMode === 'pull_request' ? 'pull_request' : env.defaultCommitMode();
  const project = await createProject({
    ownerId: uid,
    repoFullName,
    defaultBranch,
    commitMode,
    installationId: auth.installationId,
  });
  return c.json({ project });
});

app.get('/projects/:id/tasks', async (c) => {
  const uid = getUid(c);
  const project = await requireProject(c.req.param('id'), uid);
  const tasks = await listTasksForProject(project.id);
  return c.json({ tasks });
});

// Phase 3: repo file browser — reads the default branch tree (recursive,
// capped at 500 entries) so the SPA can show what files exist before prompting.
app.get('/projects/:id/files', async (c) => {
  const uid = getUid(c);
  const project = await requireProject(c.req.param('id'), uid);
  const auth = await resolveGithubAuth(uid);
  const octokit = octokitFor(auth.token);
  const [owner, repo] = project.repoFullName.split('/');
  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: project.defaultBranch,
      recursive: '1',
    });
    const files: RepoFile[] = (data.tree ?? [])
      .filter(
        (e): e is { path: string; type: string; sha: string; size?: number } =>
          !!e.path && (e.type === 'blob' || e.type === 'tree'),
      )
      .slice(0, 500)
      .map((e) => ({
        path: e.path,
        type: e.type === 'tree' ? ('tree' as const) : ('blob' as const),
        size: e.size,
        sha: e.sha,
      }));
    return c.json({ files, truncated: !!data.truncated });
  } catch (e: any) {
    if (e?.status === 404) throw new AppError('NOT_FOUND', 'repo tree not found');
    throw new AppError('GITHUB_UNAVAILABLE', `failed to read repo tree: ${e.message}`);
  }
});

export default app;
