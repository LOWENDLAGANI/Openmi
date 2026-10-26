import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { GithubError, canListRepos, getViewerWithScopes } from "@/lib/github/client";
import { looksLikeGithubToken } from "@/lib/github/oauth";
import { assessPat, normalizeConnectionLabel } from "@/lib/github/pat";
import {
  connectionIdFor,
  connectionsConfigured,
  listGithubConnections,
  readDefaultConnectionId,
  saveGithubConnection,
} from "@/lib/github/connections";

// ── GitHub connections ──────────────────────────────────────────────────────
//
// GET lists them; POST adds one from a token the person created on github.com.
//
// The token door exists because the OAuth App door depends on things that can
// break outside this codebase: a callback URL that must match character for
// character, a provider enabled in a console, a popup that a browser may block.
// A pasted token needs none of that — one `GET /user` proves it is alive, one
// repository listing proves it can read something.
//
// What is checked, in order:
//
//   1. The request came from this site and carries a verified account.
//   2. This deployment has a key to seal with, or the connection cannot be kept.
//   3. The string looks like a GitHub token at all.
//   4. GitHub accepts it, and says which account it belongs to.
//   5. GitHub lets it list a repository — the check that decides whether the
//      agent can use it, reported as a warning rather than a refusal.
//
// The token is never echoed back. The response names the login, the scopes and
// the warning, and nothing else.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — every connection this account holds, and which one is the default. */
export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to see your GitHub connections." }, { status: 401 });
  }

  if (!connectionsConfigured()) {
    return Response.json(
      {
        configured: false,
        connections: [],
        defaultId: null,
        error: "Set `GITHUB_TOKEN_KEY` to a 32-byte hex value, then redeploy.",
        detail: "no-token-key",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  const connections = await listGithubConnections(authorization, identity.uid);
  const defaultId = await readDefaultConnectionId(authorization, identity.uid);

  return Response.json(
    { configured: true, connections, defaultId: defaultId ?? connections[0]?.id ?? null },
    { headers: { "Cache-Control": "no-store" } }
  );
}

interface ConnectBody {
  token?: unknown;
  label?: unknown;
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
    return Response.json({ error: "Sign in before connecting GitHub." }, { status: 401 });
  }

  if (!connectionsConfigured()) {
    return Response.json(
      {
        error:
          "This deployment cannot store a GitHub connection yet. Set `GITHUB_TOKEN_KEY` to a 32-byte hex value, then redeploy.",
        detail: "no-token-key",
      },
      { status: 503 }
    );
  }

  // Ten attempts a minute, shared with the other GitHub doors: pasting a token
  // is a deliberate act, so a burst is a mistake or a script, not a person.
  const limit = await checkRateLimit(req, identity, "github-link");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  let body: ConnectBody;
  try {
    body = (await req.json()) as ConnectBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!looksLikeGithubToken(token)) {
    return Response.json(
      {
        error:
          "That does not look like a GitHub token. Copy it again from github.com/settings/tokens — a token is at least 20 characters with no spaces.",
        detail: "bad-token-shape",
      },
      { status: 400 }
    );
  }

  let viewer: { login: string };
  let scopes: string[] = [];
  try {
    const checked = await getViewerWithScopes(token);
    viewer = checked.viewer;
    scopes = checked.scopes;
  } catch (error) {
    if (error instanceof GithubError) {
      // A dead or revoked token is refused here. This is the one case that is a
      // refusal rather than a warning: nothing can be done with it at all.
      return Response.json(
        {
          error:
            error.status === 401
              ? "GitHub rejected that token. Check that it has not expired or been revoked, then paste a current one."
              : error.message,
          detail: "token-rejected",
        },
        { status: error.status === 429 ? 429 : 400 }
      );
    }
    return Response.json({ error: "GitHub could not be reached to check that token." }, { status: 502 });
  }

  // The token is alive. Whether it can reach repositories decides the warning,
  // never the decision: a person may be about to add the scope, and refusing
  // here would leave them with a dead end and no connection to fix.
  let canReadRepos = false;
  try {
    canReadRepos = await canListRepos(token);
  } catch (error) {
    if (error instanceof GithubError && error.status === 401) {
      return Response.json(
        { error: "GitHub accepted the token for your profile but refused it for repositories.", detail: "token-rejected" },
        { status: 400 }
      );
    }
    return Response.json({ error: "GitHub could not be reached to check the token's access." }, { status: 502 });
  }

  const assessment = assessPat({ scopes, canReadRepos });

  const saved = await saveGithubConnection(authorization, identity.uid, {
    token,
    login: viewer.login,
    scopes: scopes.join(","),
    kind: "pat",
    label: normalizeConnectionLabel(body.label, viewer.login),
    canReadRepos,
  });

  if (!saved) {
    return Response.json(
      {
        error:
          "The connection could not be saved. Check the `github_connections` policies in the Supabase project.",
        detail: "not-saved",
      },
      { status: 503 }
    );
  }

  return Response.json(
    {
      connected: true,
      // Derived, never trusted from the client: the id is a hash of the login.
      id: saved.id || connectionIdFor(saved.login),
      login: saved.login,
      scopes: saved.scopes,
      label: saved.label,
      canReadRepos: saved.canReadRepos,
      warning: assessment.warning,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
