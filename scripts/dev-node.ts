import { serve } from '@hono/node-server';
import { app } from '../worker/app';
import { setBackgroundRunner } from '../worker/platform/background';
import { envFromProcess } from '../api/env';

/**
 * Local stand-in for the Vercel runtime: same Hono app, same env adapter, same
 * background model (a long-lived process keeps promises alive on its own).
 *
 * `npm run dev:api` starts this on :8787, which is where the Vite dev proxy
 * points. Run with: node --env-file=.dev.vars --import tsx scripts/dev-node.ts
 */
setBackgroundRunner((promise) => {
  void promise;
});

const port = Number.parseInt(process.env.PORT ?? '8787', 10);

serve(
  {
    fetch: (request) => app.fetch(request, envFromProcess()),
    port,
  },
  (info) => {
    console.log(`[dev-node] OpenMi API on http://localhost:${info.port}`);
  },
);
