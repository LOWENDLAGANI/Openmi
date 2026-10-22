import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/serverControl";
import { getViewer } from "@/lib/github/client";
import {
  exchangeCode,
  githubOAuthConfig,
  oauthCallbackUrl,
  requestOrigin,
  verifyOAuthState,
} from "@/lib/github/oauth";
import {
  GITHUB_CONNECTION_COOKIE,
  GITHUB_CONNECTION_MAX_AGE_S,
  sealGithubConnection,
} from "@/lib/github/store";

// ── Finishing the GitHub round trip ──────────────────────────────────────────
//
// GitHub sends the browser here with a one-time code and the state this server
// signed. There is no Firebase token on this request — it is a top-level
// navigation — so the account is taken from the verified state and the sealed
// token goes into an httpOnly cookie bound to that uid. Every later route reads
// it with `resolveGithubLink`, which refuses a cookie belonging to anyone else.
//
// Nothing about the failure paths is silent. The browser is always sent back to
// the app with `?github=connected`, `?github=cancelled` or `?github=error`, and
// the repository panel reads that and says what happened. A dead end here is
// what "stuck at checking the connection" used to look like.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only short, known reasons travel back in a URL. */
const FAILURE_REASONS = new Set(["state", "config", "exchange", "viewer", "origin"]);

function backTo(origin: string, next: string, params: Record<string, string>): NextResponse {
  const target = new URL(next.startsWith("/") ? next : "/", origin || "http://localhost");
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return NextResponse.redirect(target);
}

function failure(origin: string, next: string, reason: string): NextResponse {
  const safeReason = FAILURE_REASONS.has(reason) ? reason : "exchange";
  return backTo(origin, next, { github: "error", reason: safeReason });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl;
  const params = url.searchParams;

  // The state is verified before anything else, because both the account and
  // the return path come from it. A return path read from the raw query string
  // would make this route an open redirect.
  const state = verifyOAuthState(params.get("state"));
  const origin = requestOrigin(req) || url.origin;
  const next = state?.next ?? "/";

  if (params.get("error")) {
    // The visitor pressed Cancel on GitHub's consent screen. Nothing failed.
    return backTo(origin, next, { github: "cancelled" });
  }

  const limit = await checkRateLimit(req, null, 30, "github");
  if (!limit.allowed) {
    return backTo(origin, next, { github: "error", reason: "exchange" });
  }

  const config = githubOAuthConfig();
  if (!config) return failure(origin, next, "config");
  if (!state) return failure(origin, next, "state");
  if (!origin) return failure(origin, next, "origin");

  const code = params.get("code") ?? "";
  const exchanged = await exchangeCode(config, code, oauthCallbackUrl(origin), req.signal);
  if (!exchanged.ok) return failure(origin, next, "exchange");

  let login = "";
  try {
    const viewer = await getViewer(exchanged.token);
    login = viewer.login;
  } catch {
    // A token that cannot even identify itself is not stored.
    return failure(origin, next, "viewer");
  }

  const sealed = sealGithubConnection(
    { token: exchanged.token, login, scopes: exchanged.scopes, linkedAt: Date.now() },
    state.uid
  );
  if (!sealed) return failure(origin, next, "config");

  const response = backTo(origin, next, { github: "connected" });
  response.cookies.set({
    name: GITHUB_CONNECTION_COOKIE,
    value: sealed,
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https://"),
    path: "/",
    maxAge: GITHUB_CONNECTION_MAX_AGE_S,
  });
  return response;
}
