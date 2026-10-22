import { getRequestListener } from '@hono/node-server';
import type { IncomingMessage, ServerResponse } from 'node:http';
import app from '../server/index.js';

// Vercel catch-all: every /api/* request lands here and is routed by Hono.
// Node runtime is selected via package.json `engines.node` (22.x).
// maxDuration 60 is valid on all Vercel plans (Hobby cap = 60s).
// Do NOT set `runtime` here or in vercel.json `functions` — a runtime string
// under a glob key containing brackets triggers Vercel's
// "Function Runtimes must have a valid version" build error.
//
// The default export MUST be a Node-style `(req, res)` handler.
// Vercel's Node.js runtime inspects the module's export shape at invocation
// time and picks one of two shapes:
//
//   1. Web handler  — used when the export exposes GET/POST/fetch, or when
//                     the *entrypoint module* exports `fetch`.
//   2. Node handler — used when the default export is a plain function, and
//                     it is invoked as `handler(req, res)`.
//
// `@hono/vercel`'s `handle(app)` returns `(request: Request) => Response`, so
// Vercel treated it as shape 2 and called it with a Node IncomingMessage.
// Hono then read `req.headers.get(...)` (a Web-only API) and threw
// "this.raw.headers.get is not a function", so every /api/* request failed
// with FUNCTION_INVOCATION_FAILED while the static SPA still loaded.
//
// `getRequestListener()` does the IncomingMessage/ServerResponse <->
// Request/Response conversion, and is the same adapter `serve()` uses, so
// the local dev server and the deployed function behave identically.
export const config = {
  maxDuration: 60,
};

const listener = getRequestListener(app.fetch);

export default (req: IncomingMessage, res: ServerResponse): Promise<void> =>
  listener(req, res);
