import { Hono } from 'hono';
import { requireAuth, getUid, getProfile } from '../auth.js';
import { env } from '../env.js';
import { getUsageToday } from '../db/quota.js';
import { countRunningTasks, sumTokenUsageToday } from '../db/tasks.js';
import { hasGithubCredential } from '../db/credentials.js';
import { getInstallationForUser } from '../db/installations.js';
import type { QuotaInfo } from '../../shared/types.js';

const app = new Hono();

app.use('*', requireAuth);

app.get('/me', async (c) => {
  const uid = getUid(c);
  const profile = getProfile(c);
  const [usedToday, runningNow, ghLinked, inst, tokensUsedToday] = await Promise.all([
    getUsageToday(uid),
    countRunningTasks(uid),
    hasGithubCredential(uid),
    getInstallationForUser(uid),
    sumTokenUsageToday(uid),
  ]);
  const limit = env.dailyTaskLimit();
  const quota: QuotaInfo = {
    dailyLimit: limit,
    usedToday,
    remainingToday: Math.max(0, limit - usedToday),
    concurrentLimit: env.maxConcurrentTasks(),
    runningNow,
    tokensUsedToday,
  };
  return c.json({
    profile: { ...profile, githubLinked: ghLinked || !!inst, githubAppInstalled: !!inst },
    quota,
  });
});

export default app;
