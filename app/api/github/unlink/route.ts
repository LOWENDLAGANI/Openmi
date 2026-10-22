import { NextRequest } from "next/server";
import { isSameOriginRequest, checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { clearGithubLink } from "@/lib/github/store";

// ── Disconnecting GitHub ─────────────────────────────────────────────────────
//
// Removing the connection removes the sealed token. Projects that reference a
// repository are left alone: they are pointers, not credentials, and deleting
// them would throw away the user's place in a repository for a problem that is
// only about access. The next read simply reports that GitHub is not connected.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");

  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in before disconnecting GitHub." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 10, "github");
  if (!limit.allowed) {
    return Response.json({ error: `Too many attempts. Try again in ${limit.retryAfterSeconds}s.` }, { status: 429 });
  }

  const cleared = await clearGithubLink(authorization, identity.uid);
  return Response.json(
    { connected: false, cleared },
    { headers: { "Cache-Control": "no-store" } }
  );
}
