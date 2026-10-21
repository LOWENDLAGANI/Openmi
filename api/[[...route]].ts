import { handle } from 'hono/vercel';
import app from '../server/index.js';

// Vercel catch-all: every /api/* request lands here and is routed by Hono.
// Node runtime is selected via package.json `engines.node` (22.x).
// maxDuration is set here; do NOT set `runtime` in this export or in
// vercel.json `functions` — a `runtime` string with a glob key containing
// brackets triggers Vercel's "Function Runtimes must have a valid version"
// build error.
export const config = {
  maxDuration: 300,
};

export default handle(app);
