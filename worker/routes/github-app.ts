import { Hono } from 'hono';
import type { AppEnv } from '../auth/middleware.js';
import {
  deleteInstallation,
  getInstallationById,
  setInstallationSuspended,
  upsertInstallation,
} from '../db/installations.js';
import { loadConfig, type Env } from '../env.js';
import { AppError, isAppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { getAppInstallation, requireGithubApp } from '../github/app.js';
import { invalidateInstallationToken } from '../github/installation-tokens.js';
import { verifyInstallState } from '../github/state.js';
import { parseInstallationEvent, verifyWebhookSignature } from '../github/webhook.js';

/**
 * Public GitHub App lifecycle endpoints.
 *
 * They live outside the `/api/github/*` protected prefix on purpose: GitHub's
 * redirect and webhook deliveries carry no bearer token. The callback is
 * authenticated by the signed `state` we issued to a logged-in user; the
 * webhook is authenticated by its HMAC signature.
 */
/**
 * Post-install redirect must land on the frontend origin that owns the
 * Firebase session — auth persistence is origin-bound, so a relative redirect
 * from a callback served on a different (function/worker/preview) origin drops
 * the user back at the login screen. APP_ORIGIN is inferred from the Vercel
 * deployment URL; when unset (same-origin deploys) we fall back to a relative
 * path, preserving the previous behaviour.
 */
function appHomeRedirect(env: Env, flag: string): string {
  const origin = env.APP_ORIGIN?.trim().replace(/\/+$/, '');
  return `${origin ?? ''}/?github_app=${encodeURIComponent(flag)}`;
}
export const githubAppRoutes = new Hono<AppEnv>();

githubAppRoutes.get('/github-app/callback', async (c) => {
  const installationId = Number(c.req.query('installation_id'));
  const setupAction = c.req.query('setup_action') ?? null;
  const state = c.req.query('state') ?? '';

  if (setupAction === 'request') {
    // An org owner must approve the request; nothing to link yet.
    return c.redirect(appHomeRedirect(c.env, 'pending'), 302);
  }

  try {
    const config = loadConfig(c.env);
    if (!config.githubApp.enabled || !config.githubApp.stateSecret) {
      throw new AppError('CONFIG_ERROR', 'GitHub App is not configured');
    }
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new AppError('BAD_REQUEST', 'Missing installation_id');
    }

    const { userId } = await verifyInstallState(config.githubApp.stateSecret, state);

    // Never trust the query parameter alone: confirm this App owns it.
    const installation = await getAppInstallation(
      requireGithubApp(config.githubApp),
      installationId,
    );
    if (installation.suspended) {
      return c.redirect(appHomeRedirect(c.env, 'suspended'), 302);
    }

    await upsertInstallation(c.env, {
      installationId: installation.id,
      userId,
      accountLogin: installation.login,
      accountType: installation.accountType,
      repositorySelection: installation.repositorySelection,
      suspended: false,
    });
    await invalidateInstallationToken(c.env, installation.id);

    log.info('github.app_installed', { installationId: installation.id, userId });
    return c.redirect(appHomeRedirect(c.env, 'installed'), 302);
  } catch (error) {
    log.warn('github.app_callback_rejected', {
      installationId: Number.isFinite(installationId) ? installationId : null,
      code: isAppError(error) ? error.code : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
    });
    return c.redirect(appHomeRedirect(c.env, 'error'), 302);
  }
});

githubAppRoutes.post('/webhooks/github', async (c) => {
  const config = loadConfig(c.env);
  const secret = config.githubApp.webhookSecret;

  if (!config.githubApp.enabled || !secret) {
    throw new AppError('CONFIG_ERROR', 'GitHub App webhook is not configured', { status: 503 });
  }

  // Read the raw bytes once: the signature covers exactly these bytes.
  const rawBody = await c.req.arrayBuffer();
  const valid = await verifyWebhookSignature(
    rawBody,
    c.req.header('x-hub-signature-256') ?? null,
    secret,
  );
  if (!valid) {
    throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature');
  }

  if (c.req.header('x-github-event') !== 'installation') {
    return c.body(null, 204);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new AppError('BAD_REQUEST', 'Webhook body is not JSON');
  }

  const event = parseInstallationEvent(payload);
  if (!event) return c.body(null, 204);

  // Defense in depth: a shared webhook secret could serve multiple Apps.
  if (
    config.githubApp.appId &&
    event.appId !== null &&
    String(event.appId) !== config.githubApp.appId
  ) {
    log.warn('github.webhook_wrong_app', { appId: event.appId });
    return c.body(null, 204);
  }

  switch (event.action) {
    case 'deleted': {
      await deleteInstallation(c.env, event.installationId);
      await invalidateInstallationToken(c.env, event.installationId);
      log.info('github.app_uninstalled', { installationId: event.installationId });
      break;
    }
    case 'suspend':
    case 'unsuspend': {
      await setInstallationSuspended(c.env, event.installationId, event.action === 'suspend');
      await invalidateInstallationToken(c.env, event.installationId);
      break;
    }
    case 'created':
    case 'new_permissions_accepted': {
      // A webhook can arrive before the browser callback; keep any existing
      // user link rather than overwriting it with null.
      const existing = await getInstallationById(c.env, event.installationId);
      await upsertInstallation(c.env, {
        installationId: event.installationId,
        ...(existing?.user_id ? { userId: existing.user_id } : {}),
        accountLogin: event.login,
        accountType: event.accountType,
        repositorySelection: event.repositorySelection,
        suspended: event.suspended,
      });
      await invalidateInstallationToken(c.env, event.installationId);
      break;
    }
    default:
      return c.body(null, 204);
  }

  return c.body(null, 202);
});
