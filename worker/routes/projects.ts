import { Hono } from 'hono';
import { z } from 'zod';
import type { ProjectView } from '../../shared/types';
import type { AppEnv } from '../auth/middleware';
import { createProject, listProjects, toProjectView } from '../db/projects';
import { getRepoInfo } from '../github/repo';
import { getGithubToken } from '../github/token';
import { AppError } from '../lib/errors';
import { readJson } from '../lib/http';

export const projectRoutes = new Hono<AppEnv>();

const createProjectSchema = z.object({
  repoFullName: z.string().min(3).max(200),
  name: z.string().trim().min(1).max(80).optional(),
  commitMode: z.enum(['direct', 'pull_request']).optional(),
});

projectRoutes.get('/projects', async (c) => {
  const projects = await listProjects(c.env, c.var.user.id);
  c.header('cache-control', 'private, no-store');
  return c.json({ projects });
});

projectRoutes.post('/projects', async (c) => {
  const user = c.var.user;
  const body = await readJson(c, createProjectSchema);
  const token = await getGithubToken(c.env, user.id);

  const repo = await getRepoInfo(token, body.repoFullName);
  if (!repo.canPush) {
    throw new AppError(
      'GITHUB_FORBIDDEN',
      `Your GitHub account cannot push to ${repo.fullName}. Choose a repository you own or can write to.`,
    );
  }

  const row = await createProject(c.env, {
    ownerId: user.id,
    name: body.name ?? repo.fullName.split('/')[1] ?? repo.fullName,
    repoFullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    commitMode: body.commitMode ?? 'direct',
  });

  const view: ProjectView = toProjectView(row);
  c.header('cache-control', 'private, no-store');
  return c.json({ project: view }, 201);
});
