// Verify the Vercel handler loads on plain Node AND satisfies the Node
// `(req, res)` contract that Vercel's Node.js runtime dispatches.
//
// Vercel chooses the handler shape from the module's exports:
//   - GET/POST/fetch present -> Web handler (Request -> Response)
//   - plain default export    -> Node handler (req, res)
// A web-style default export is silently called as (req, res) and throws
// "this.raw.headers.get is not a function", which surfaces on the deployment
// as FUNCTION_INVOCATION_FAILED for every /api/* route.
import 'dotenv/config';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

const WEB_HANDLER_KEYS = [
  'fetch',
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'HEAD',
];

async function main() {
  const mod = await import('../api/[[...route]].js');
  const handler = mod.default as unknown;

  if (typeof handler !== 'function') {
    throw new Error('handler default export is not a function');
  }

  // Vercel unwraps `default` before it looks for a web handler, so a `fetch`
  // export sitting next to the default export is ignored. Fail loudly rather
  // than shipping a handler whose shape the platform quietly ignores.
  if (typeof (mod as Record<string, unknown>).fetch === 'function') {
    throw new Error(
      'the module exports `fetch` alongside the default export; Vercel unwraps the default export first and would never call `fetch`',
    );
  }

  for (const key of WEB_HANDLER_KEYS) {
    if (typeof (handler as unknown as Record<string, unknown>)[key] === 'function') {
      throw new Error(
        `handler looks like a web handler (exposes ${key}); Vercel would not call the default export as (req, res)`,
      );
    }
  }

  // Drive the handler through a real HTTP server, i.e. exactly how Vercel
  // invokes it.
  const server = createServer((req, res) => {
    Promise.resolve((handler as NodeHandler)(req, res)).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.stack ?? err.message : String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    if (res.status !== 200) {
      throw new Error(
        `GET /api/health returned ${res.status}: ${body.slice(0, 300)}\n` +
          'A web-style (Request -> Response) default export is called as (req, res) ' +
          'by Vercel and throws "this.raw.headers.get is not a function". ' +
          'Export a Node-style (req, res) handler instead.',
      );
    }
    JSON.parse(body);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('ok: Vercel handler loads on plain Node and serves /api/health');
}

main().catch((e) => {
  console.error('check:node failed:', e);
  process.exit(1);
});
