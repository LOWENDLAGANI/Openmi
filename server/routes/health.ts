import { Hono } from 'hono';
import { env, missingConfigKeys, firebaseConfigured, githubAppConfigured } from '../env.js';
import { configChecks } from '../config-catalogue.js';
import type { HealthResponse, PublicConfig } from '../../shared/types.js';

const app = new Hono();

app.get('/health', (c) => {
  const body: HealthResponse = {
    ok: true,
    time: Date.now(),
    missingConfig: missingConfigKeys(),
    firebaseConfigured: firebaseConfigured(),
    githubAppConfigured: githubAppConfigured(),
    openRouterConfigured: env.openRouterApiKey() !== undefined,
    // Names, purposes and presence only — never values.
    checks: configChecks(),
  };
  return c.json(body);
});

app.get('/config', (c) => {
  const config: PublicConfig = {
    firebase: {
      apiKey: env.firebaseApiKey() ?? '',
      authDomain: env.firebaseAuthDomain() ?? '',
      projectId: env.firebaseProjectId() ?? '',
      appId: env.firebaseAppId(),
    },
    githubAppConfigured: githubAppConfigured(),
    githubAppInstallUrl: env.githubAppSlug()
      ? `https://github.com/apps/${env.githubAppSlug()}/installations/new`
      : undefined,
    defaultCommitMode: env.defaultCommitMode(),
    dailyTaskLimit: env.dailyTaskLimit(),
    maxConcurrentTasks: env.maxConcurrentTasks(),
    model: env.model(),
  };
  return c.json(config);
});

export default app;
