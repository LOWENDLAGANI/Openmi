import { setupReport } from "@/lib/setupChecks";

// ── What this deployment is missing ──────────────────────────────────────────
// Read by the About page's setup banner, with no authentication and on
// purpose: the banner is what an owner looks at in the first five minutes of a
// deployment, before any account exists, so gating it would hide exactly the
// person who needs it.
//
// That makes the answer public, which is why it is a list of booleans. The
// report says a key is set or unset and never what it holds — see
// lib/setupChecks.ts for the whole rule.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(setupReport(), {
    headers: { "cache-control": "no-store" },
  });
}
