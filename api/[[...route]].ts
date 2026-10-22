import { handle } from '@hono/vercel';
import app from '../server/index.js';

// Vercel catch-all: every /api/* request lands here and is routed by Hono.
// Node runtime is selected via package.json `engines.node` (22.x).
// maxDuration 60 is valid on all Vercel plans (Hobby cap = 60s).
// Do NOT set `runtime` here or in vercel.json `functions` — a runtime string
// under a glob key containing brackets triggers Vercel's
// "Function Runtimes must have a valid version" build error.
export const config = {
  maxDuration: 60,
};

export default handle(app);
