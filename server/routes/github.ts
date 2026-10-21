import { Hono } from 'hono';
import { requireAuth, getUid } from '../auth.js';
import { storeGithubCredential, getGithubCredential } from '../db/credentials.js';
import { setProfileFlag } from '../db/profiles.js';
import { getInstallationForUser, claimInstallation, recordInstallation } from '../db/installations.js';
import { signInstallState, verifyInstallState, verifyGithubWebhook } from '../github/webhook.js';
import { signAppJwt, octokitFor, resolveGithubAuth } from '../github/auth.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';
import { Octokit } from '@octokit/rest';

const app = new Hono();

// Authenticated: store the OAuth token from the GitHub link step (encrypted).
app.post('/github/link', requireAuth, async (c) => {
  const uid = getUid(c);
  const body = await c.req.json().catch(() => ({}));
  const token = body?.token as string | undefined;
  const scopes = (body?.scopes as string | undefined)?.split(',') ?? ['repo', 'read:user'];
  if (!token) throw new AppError('INVALID_INPUT', 'missing token');
  await storeGithubCredential(uid, token, scopes);
  await setProfileFlag(uid, 'githubLinked', true);
  return c.json({ ok: true });
});

// Authenticated: mint a signed GitHub App install URL.
app.post('/github/app/install', requireAuth, async (c) => {
  const uid = getUid(c);
  if (!env.githubAppId() || !env.githubAppSlug()) {
    throw new AppError('CONFIG_ERROR', 'GitHub App not configured');
  }
  const state = signInstallState(uid);
  const url = `https://github.com/apps/${env.githubAppSlug()}/installations/new?state=${encodeURIComponent(state)}`;
  return c.json({ url });
});

// Public: GitHub App setup redirect. Verifies signed state, re-reads the
// installation from the API to confirm this App owns it, then claims it.
app.get('/github-app/callback', async (c) => {
  const installationId = c.req.query('installation_id');
  const stateParam = c.req.query('state');
  if (!installationId || !stateParam) {
    return c.text('invalid callback', 400);
  }
  let userId: string;
  try {
    const state = verifyInstallState(stateParam);
    userId = state.userId;
  } catch {
    return c.text('invalid or expired install state', 403);
  }
  try {
    // Re-read installation from the API to confirm this App owns it.
    const appClient = new Octokit({ auth: signAppJwt() });
    const { data: inst } = await appClient.apps.getInstallation({
      installation_id: Number(installationId),
    });
    if (String(inst.app_id) !== env.githubAppId()) {
      return c.text('installation does not belong to this app', 403);
    }
    await claimInstallation(Number(installationId), userId);
    await recordInstallation(Number(installationId), {
      accountLogin: (inst.account as any)?.login,
      suspended: false,
    });
    await setProfileFlag(userId, 'githubAppInstalled', true);
  } catch (e: any) {
    if (e?.status === 404) return c.text('installation not found', 404);
    throw e;
  }
  const origin = env.appOrigin() ?? '';
  return c.redirect(`${origin}/?installed=1`);
});

// Public: GitHub webhook (HMAC verified). Installation lifecycle only.
app.post('/webhooks/github', async (c) => {
  const raw = await c.req.text();
  await verifyGithubWebhook(raw, c.req.header('x-hub-signature-256'));
  const event = c.req.header('x-github-event');
  if (event !== 'installation') {
    return c.json({ ok: true, ignored: true });
  }
  const payload = JSON.parse(raw);
  if (String(payload.installation?.app_id) !== env.githubAppId()) {
    return c.json({ ok: true, ignored: true });
  }
  const action = payload.action;
  const installationId = payload.installation?.id as number;
  const accountLogin = payload.installation?.account?.login;
  if (action === 'created' || action === 'unsuspend') {
    await recordInstallation(installationId, { accountLogin, suspended: false });
  } else if (action === 'deleted') {
    await recordInstallation(installationId, { accountLogin, suspended: true });
  } else if (action === 'suspend') {
    await recordInstallation(installationId, { suspended: true });
  }
  return c.json({ ok: true });
});

// Authenticated: list repos the agent can write to.
app.get('/github/repos', requireAuth, async (c) => {
  const uid = getUid(c);
  const auth = await resolveGithubAuth(uid).catch(() => undefined);
  if (!auth) {
    return c.json({ repos: [], needsLink: true });
  }
  const octokit = octokitFor(auth.token);
  try {
    const { data } = await octokit.repos.listForAuthenticatedUser({
      per_page: 100,
      sort: 'updated',
    });
    const repos = data
      .filter((r: any) => r.permissions?.push || r.permissions?.admin)
      .map((r: any) => ({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
      }));
    return c.json({ repos, kind: auth.kind });
  } catch (e: any) {
    const status = e?.status ?? e?.response?.status;
    if (status === 401 || status === 403) {
      return c.json({ repos: [], needsLink: true });
    }
    throw new AppError('GITHUB_UNAVAILABLE', `failed to list repos: ${e.message}`);
  }
});

export default app;
