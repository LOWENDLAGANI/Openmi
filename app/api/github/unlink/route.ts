import { NextRequest } from "next/server";
import { isSameOriginRequest, checkRateLimit, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { GITHUB_CONNECTION_COOKIE, clearGithubLink } from "@/lib/github/store";

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

  const limit = await checkRateLimit(req, identity, "github-link");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const cleared = await clearGithubLink(authorization, identity.uid);
  const response = Response.json(
    { connected: false, cleared },
    { headers: { "Cache-Control": "no-store" } }
  );
  // A connection made through GitHub's own OAuth App lives in a sealed cookie
  // rather than the database, so disconnecting has to remove both. Leaving the
  // cookie behind would make "Disconnect" a button that visibly does nothing.
  response.headers.append(
    "Set-Cookie",
    `${GITHUB_CONNECTION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
  return response;
}
