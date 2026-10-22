import { Hono, type Context } from 'hono';
import { requireAuth, getUid } from '../auth.js';
import { listProjects, createProject, requireProject } from '../db/projects.js';
import { listTasksForProject } from '../db/tasks.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';
import { resolveGithubAuth, octokitFor } from '../github/auth.js';
import type { RepoFile, Issue } from '../../shared/types.js';
import { issue, summarizeIssues } from '../errors.js';

const app = new Hono();

// Auth is attached per route: a wildcard middleware here would also guard
// the internal runner, the cron endpoint and the GitHub webhook.
app.get('/projects', requireAuth, async (c) => {
  const uid = getUid(c);
  const projects = await listProjects(uid);
  return c.json({ projects });
});

app.post('/projects', requireAuth, async (c) => {
  const uid = getUid(c);
  const body = await c.req.json().catch(() => ({}));
  const repoFullName = body?.repoFullName as string | undefined;
  const issues: Issue[] = [];
  if (!repoFullName) {
    issues.push(issue('MISSING_REPO', 'repoFullName is required', { field: 'repoFullName' }));
  } else if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
    issues.push(
      issue('INVALID_REPO', `repoFullName must be owner/name, got "${repoFullName}"`, {
        field: 'repoFullName',
      }),
    );
  }
  if (
    body?.commitMode !== undefined &&
    body?.commitMode !== 'direct' &&
    body?.commitMode !== 'pull_request'
  ) {
    issues.push(
      issue('INVALID_COMMIT_MODE', 'commitMode must be "direct" or "pull_request"', {
        field: 'commitMode',
      }),
    );
  }
  if (issues.length) {
    throw new AppError('INVALID_INPUT', summarizeIssues(issues), { details: { issues } });
  }
  // Narrowed by the MISSING_REPO issue above: an empty repoFullName always
  // produces an issue, so it cannot reach this point.
  const repo = repoFullName!;
  // Verify the user can actually write to this repo.
  const auth = await resolveGithubAuth(uid);
  const octokit = octokitFor(auth.token);
  const [owner, repoName] = repo.split('/');
  let defaultBranch = 'main';
  try {
    const { data } = await octokit.repos.get({ owner, repo: repoName });
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
    repoFullName: repo,
    defaultBranch,
    commitMode,
    installationId: auth.installationId,
  });
  return c.json({ project });
});

app.get('/projects/:id/tasks', requireAuth, async (c) => {
  const uid = getUid(c);
  const project = await requireProject(requireParamId(c, 'project id is required'), uid);
  const tasks = await listTasksForProject(project.id);
  return c.json({ tasks });
});

// Phase 3: repo file browser — reads the default branch tree (recursive,
// capped at 500 entries) so the SPA can show what files exist before prompting.
app.get('/projects/:id/files', requireAuth, async (c) => {
  const uid = getUid(c);
  const project = await requireProject(requireParamId(c, 'project id is required'), uid);
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
      .filter((e) => !!e.path && (e.type === 'blob' || e.type === 'tree'))
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

// A path parameter that is missing is a bad request, not a crash further down.
export function requireParamId(c: Context, message: string): string {
  const id = c.req.param('id');
  if (!id) {
    throw new AppError('INVALID_INPUT', message, {
      details: { issues: [issue('MISSING_ID', message, { field: 'id' })] },
    });
  }
  return id;
}

export default app;
