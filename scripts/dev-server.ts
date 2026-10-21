// Local Node API server on :8787 — runs the exact same Hono app Vercel runs.
import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from '../server/index.js';

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`OpenMi API listening on http://localhost:${info.port}`);
});
