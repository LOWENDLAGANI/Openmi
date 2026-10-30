import { NextRequest } from "next/server";
import {
  checkRateLimit,
  isSameOriginRequest,
  rateLimitRefusal,
  verifyCaller,
} from "@/lib/serverControl";
import { cancelRun, readOwnRun } from "@/lib/agentRuns";

// ── Stop means stop ──────────────────────────────────────────────────────────
//
// The composer's Stop used to abort a poll. That was honest when the loop lived
// in the tab; now the server drives the run, so aborting the poll would leave a
// turn spending model calls and GitHub reads with nobody watching it. This is
// the other half of the background feature: a run that can be ended.
//
// Ownership is answered by Postgres, not by this route: the run is read with the
// caller's own JWT, so RLS decides whether the id in the URL is theirs. Only
// after that read does the conditional update run with the service key — the
// same key the tick uses, because a cancelled run has to be closed even though
// no browser is trusted to write one.
//
// Deliberately not gated on the administrator's pause or the daily cap: stopping
// work is not a request for work, and trapping somebody in a run they cannot
// end would spend their budget on the swing of a switch.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authorization = req.headers.get("authorization");

  if (!isSameOriginRequest(req.headers)) {
    return Response.json(
      { error: "This request did not come from Openmi.", detail: "cross-origin" },
      { status: 403 }
    );
  }

  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to stop a repository run." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "agent");
  if (!limit.allowed) {
    return rateLimitRefusal(
      limit,
      `Too many agent steps at once. Please wait ${limit.retryAfterSeconds}s and try again.`
    );
  }

  const { id } = await context.params;
  const own = await readOwnRun(authorization, identity.uid, id);
  if (!own) {
    // Not yours and not there are the same answer: an id is not a capability.
    return Response.json({ error: "That run is not available." }, { status: 404 });
  }

  // A run that already ended is answered with itself rather than an error: a
  // double click, or a poll that finished first, is not a failure.
  if (own.status === "running") {
    await cancelRun(id, identity.uid);
  }

  const after = (await readOwnRun(authorization, identity.uid, id)) ?? own;
  return Response.json(
    { run: after },
    { headers: { "Cache-Control": "no-store" } }
  );
}
