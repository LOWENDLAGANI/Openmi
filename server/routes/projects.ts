import { Hono } from 'hono';
import { requireAuth, getUid } from '../auth.js';
import { listProjects, createProject, requireProject } from '../db/projects.js';
import { listTasksForProject } from '../db/tasks.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';
import { resolveGithubAuth, octokitFor } from '../github/auth.js';

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

export default app;
