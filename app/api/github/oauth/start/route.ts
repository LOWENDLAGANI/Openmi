import { NextRequest } from "next/server";
import { isSameOriginRequest, checkRateLimit, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import {
  authorizeUrl,
  createOAuthState,
  githubOAuthConfig,
  githubOAuthConfigured,
  oauthCallbackUrl,
  requestOrigin,
  safeReturnPath,
  signOAuthState,
} from "@/lib/github/oauth";
import { githubStoreConfigured } from "@/lib/github/store";

// ── Beginning the GitHub round trip ─────────────────────────────────────────
//
// The browser asks for a consent URL with its Supabase access token attached, so the
// state the server signs is bound to the account that will own the connection.
// Nothing secret is returned — the state is signed, not encrypted, and contains
// only a uid and an expiry — and the client id is public by design.
//
// This is a POST rather than a redirect route for one reason: identity. A
// redirect cannot carry the Authorization header, and without the verified uid
// the callback would have no account to attach the result to.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartBody {
  next?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json(
      { error: "This request did not come from Openmi.", detail: "cross-origin" },
      { status: 403 }
    );
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json(
      { error: "Sign in before connecting GitHub.", detail: "not-signed-in" },
      { status: 401 }
    );
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

  const config = githubOAuthConfig();
  if (!config || !githubOAuthConfigured()) {
    return Response.json(
      {
        error:
          "This deployment has no GitHub OAuth App configured. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, then redeploy.",
        detail: "oauth-not-configured",
      },
      { status: 503 }
    );
  }

  const limit = await checkRateLimit(req, identity, "github-manage");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  let body: StartBody = {};
  try {
    body = (await req.json()) as StartBody;
  } catch {
    // An empty body is fine: the return path has a default.
  }

  const origin = requestOrigin(req);
  if (!origin) {
    return Response.json(
      {
        error:
          "This deployment does not know its own public address, so GitHub cannot send the browser back. Set `NEXT_PUBLIC_SITE_URL` and redeploy.",
        detail: "no-origin",
      },
      { status: 503 }
    );
  }

  const state = createOAuthState(identity.uid, { next: safeReturnPath(body.next) });
  const signed = signOAuthState(state);
  if (!signed) {
    return Response.json(
      { error: "The GitHub connection could not be prepared. Try again.", detail: "no-state" },
      { status: 503 }
    );
  }

  return Response.json(
    {
      url: authorizeUrl(config, origin, signed),
      redirectUri: oauthCallbackUrl(origin),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
