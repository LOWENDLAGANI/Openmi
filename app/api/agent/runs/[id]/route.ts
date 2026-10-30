import { NextRequest } from "next/server";
import { verifyCaller } from "@/lib/serverControl";
import { readOwnRun } from "@/lib/agentRuns";

// ── Watch a run ──────────────────────────────────────────────────────────────
//
// The chat polls this. It is the only run endpoint a browser may call, and it
// reads with the caller's own token so RLS answers "is this yours?" — the route
// never has to trust the id in the URL.
//
// A run is readable after it finishes as well: reopening a chat should show the
// answer, the reads behind it and the review card exactly as they were, not an
// empty row because the turn is over.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const identity = await verifyCaller(req.headers.get("authorization"));
  if (!identity) {
    return Response.json({ error: "Sign in to watch a repository run." }, { status: 401 });
  }

  const { id } = await context.params;
  const run = await readOwnRun(req.headers.get("authorization"), identity.uid, id);
  if (!run) return Response.json({ error: "That run is not available." }, { status: 404 });

  return Response.json(
    { run },
    {
      // A run's progress is per-person and changes on every step.
      headers: { "Cache-Control": "no-store" },
    }
  );
}
