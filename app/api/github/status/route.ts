import { NextRequest } from "next/server";
import { verifyCaller } from "@/lib/serverControl";
import { githubStoreConfigured, resolveGithubLink } from "@/lib/github/store";
import { githubOAuthConfigured } from "@/lib/github/oauth";

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
  const link = configured ? await resolveGithubLink(req, authorization, identity.uid) : null;

  return Response.json(
    {
      configured,
      connected: Boolean(link),
      login: link?.login || null,
      linkedAt: link?.linkedAt ?? null,
      // Whether the GitHub OAuth App path is available. The panel uses this to
      // decide between the native round trip and the Firebase-hosted link, and
      // a deployment with neither gets a setup message instead of a button
      // that cannot work.
      oauth: githubOAuthConfigured(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
