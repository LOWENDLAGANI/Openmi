import { getRequestListener } from '@hono/node-server';
import { waitUntil } from '@vercel/functions';
import { app } from '../worker/app';
import { setBackgroundRunner } from '../worker/platform/background';
import { envFromProcess } from './env';

/**
 * Vercel entry point.
 *
 * `api/index.ts` is the single serverless function behind `/api/*` (see
 * vercel.json). It uses the classic Node `(req, res)` signature via Hono's
 * request listener rather than a framework adapter, so it works on the Node.js
 * runtime with no Vercel-specific build step.
 *
 * Post-response work (task dispatch, the recovery sweep) is kept alive with
 * `waitUntil`, which Vercel scopes to the current invocation and bounds by the
 * function's `maxDuration` (300 s in vercel.json).
 */
setBackgroundRunner((promise) => {
  waitUntil(promise);
});

const listener = getRequestListener((request: Request) => app.fetch(request, envFromProcess()));

export default listener;
