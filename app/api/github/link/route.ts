import { NextRequest } from "next/server";
import { isSameOriginRequest, checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { getViewer } from "@/lib/github/client";
import { saveGithubLink, githubStoreConfigured } from "@/lib/github/store";

// ── Connecting GitHub ────────────────────────────────────────────────────────
//
// The browser runs the Firebase GitHub link flow and receives an access token.
// It posts that token here once, over the same origin, and the server:
//
//   1. verifies the caller's Firebase token,
//   2. asks GitHub who the token belongs to — a token that cannot even identify
//      itself is not stored,
//   3. seals it and writes it under the caller's account.
//
// The token is never echoed back. From this point the browser has no copy the
// server depends on, and `github/status` answers with a login and a date.
//
// GitHub is authorisation, not a second login: the Firebase user is unchanged,
// so the history and the Dew wallet attached to it do not move.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LinkBody {
  accessToken?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");

  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in before connecting GitHub." }, { status: 401 });
  }

  if (!githubStoreConfigured()) {
    return Response.json(
      {
        error:
          "This deployment cannot store a GitHub connection yet. Set `GITHUB_TOKEN_KEY` to a 32-byte hex value, then redeploy.",
        detail: "no-token-key",
      },
      { status: 503 }
    );
  }

  const limit = await checkRateLimit(req, identity, 10, "github");
  if (!limit.allowed) {
    return Response.json({ error: `Too many attempts. Try again in ${limit.retryAfterSeconds}s.` }, { status: 429 });
  }

  let body: LinkBody;
  try {
    body = (await req.json()) as LinkBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  // GitHub tokens are long, opaque, and start with a known prefix for the
  // modern formats. A shape check keeps an obvious mistake from becoming a
  // stored value and a failed request later.
  if (!/^(gho_|ghu_|ghs_|ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(accessToken)) {
    return Response.json({ error: "That does not look like a GitHub access token." }, { status: 400 });
  }

  let viewer;
  try {
    viewer = await getViewer(accessToken);
  } catch {
    return Response.json(
      { error: "GitHub rejected that connection. Try connecting again." },
      { status: 400 }
    );
  }

  const saved = await saveGithubLink(authorization, identity.uid, {
    token: accessToken,
    login: viewer.login,
    scopes: "repo",
  });

  if (!saved) {
    return Response.json(
      { error: "The connection could not be saved. Check the database rules for `users/{uid}/github`." },
      { status: 503 }
    );
  }

  return Response.json(
    { connected: true, login: viewer.login },
    { headers: { "Cache-Control": "no-store" } }
  );
}
