import { NextRequest } from "next/server";
import { verifyCaller } from "@/lib/serverControl";
import { githubStoreConfigured, resolveGithubLink } from "@/lib/github/store";
import { githubOAuthConfigured } from "@/lib/github/oauth";
import { connectionsConfigured, listGithubConnections, readDefaultConnectionId } from "@/lib/github/connections";

// ── Is GitHub connected, and how? ───────────────────────────────────────────
//
// The interface asks this once when the workspace opens. The answer is logins
// and dates; the access token is never part of any response. Three flags say
// which doors exist, because they have three different remedies:
//
//   `configured`  this deployment has a key to seal connections with at all
//   `pat`         a personal access token can be pasted (always true with a key)
//   `oauth`       a GitHub OAuth App is set up, so the round trip is available
//
// `connected` keeps its old meaning — "the agent has a credential it can use" —
// and is now true when a connection is in the collection, in the sealed cookie,
// or in the legacy single node.

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

  const connections = configured ? await listGithubConnections(authorization, identity.uid) : [];
  const storedDefault = configured ? await readDefaultConnectionId(authorization, identity.uid) : null;

  return Response.json(
    {
      configured,
      connected: Boolean(link),
      /** The credential a repository read will actually use. */
      login: link?.login || null,
      linkedAt: link?.linkedAt ?? null,
      /** Every connection this account holds, newest first. Never the token. */
      connections,
      defaultId: storedDefault ?? connections[0]?.id ?? null,
      /** A pasted token is the door that needs no console change. */
      pat: connectionsConfigured(),
      oauth: githubOAuthConfigured(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
