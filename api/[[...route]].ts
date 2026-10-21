import { handle } from '@hono/node-server/vercel';
import app from '../server/index.js';

// Vercel catch-all: every /api/* request lands here and is routed by Hono.
export const config = {
  runtime: 'nodejs22.x',
  maxDuration: 300,
};

export default handle(app);
