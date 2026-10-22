import { NextRequest } from "next/server";
import { verifyCaller } from "@/lib/serverControl";
import { githubStoreConfigured, readGithubSummary } from "@/lib/github/store";

// ── Is GitHub connected? ─────────────────────────────────────────────────────
//
// The interface asks this once when the workspace opens. The answer is a login
// and a date; the access token is never part of any response. `configured`
// distinguishes "this deployment has no key for storing connections" from "this
// person has not connected yet", because those two have different remedies.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to check your GitHub connection." }, { status: 401 });
  }

  const configured = githubStoreConfigured();
  const summary = configured ? await readGithubSummary(authorization, identity.uid) : null;

  return Response.json(
    {
      configured,
      connected: Boolean(summary),
      login: summary?.login ?? null,
      linkedAt: summary?.linkedAt ?? null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
