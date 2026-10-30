// ── GitHub OAuth, on the app's own OAuth App ─────────────────────────────────
//
// A GitHub OAuth App is created once by the deployment owner —
// `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` — and then every visitor can
// connect GitHub from the app itself, with no identity provider and no second
// account. GitHub stays authorisation: the account is still the Supabase user,
// and the access token is sealed with the deployment key before it is written
// anywhere. The token-paste door in the repository panel is the fallback for a
// deployment that has not created the app.
//
// The flow is a full-page round trip rather than a popup:
//
//   1. The browser posts to `/api/github/oauth/start` with its access token.
//   2. The server signs a short-lived state containing the caller's uid and
//      answers with the GitHub authorize URL.
//   3. GitHub redirects to `/api/github/oauth/callback`, which exchanges the code
//      for a token and seals it into an httpOnly cookie for this browser.
//   4. The browser is sent back to the app, which opens the repository panel.
//
// The state is signed with the same key that seals tokens, so a callback cannot
// name a different account: the uid in it is the uid the server minted it for,
// and the cookie is only accepted by that uid (`resolveGithubLink`). A popup was
// rejected because popup blockers and embedded views turn "connect GitHub" into
// a dead button, which is the failure this module exists to remove.

import { sign, tokenKey, verify } from "./crypto";

/** The scope the agent needs: read repositories, and later commit to them. */
export const GITHUB_OAUTH_SCOPES = "repo";

/** How long a visitor has to finish the GitHub round trip. */
const STATE_TTL_MS = 10 * 60_000;

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** What the signed state carries between the two halves of the flow. */
export interface GithubOAuthState {
  v: 1;
  /** The account the connection will belong to. */
  uid: string;
  /** Where to send the browser afterwards. Always an app-relative path. */
  next: string;
  /** Epoch ms after which the state is refused. */
  exp: number;
}

/**
 * The OAuth App credentials, or null when this deployment has none.
 *
 * Both values are server-only. A deployment without them keeps the token-paste
 * door in the repository panel — it does not lose the feature, it just has one
 * fewer way in.
 */
export function githubOAuthConfig(): GithubOAuthConfig | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * True when the native flow can actually be used.
 *
 * The token key is part of the answer: a flow that ends by sealing a token into
 * a cookie with no key would fail at the last step, after the visitor has
 * already authorised the app. Reporting it as unavailable up front is the
 * honest version.
 */
export function githubOAuthConfigured(): boolean {
  return githubOAuthConfig() !== null && tokenKey() !== null;
}

/**
 * A path inside this app, or `/`.
 *
 * The return path travels through GitHub and comes back in a query string, so
 * it is attacker-shaped input by the time it is read. An absolute URL here
 * would turn the callback into an open redirect, which is why only
 * app-relative paths survive.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return "/";
  if (trimmed.startsWith("//")) return "/";
  if (trimmed.includes("\\") || trimmed.includes("\0")) return "/";
  if (trimmed.length > 200) return "/";
  return trimmed;
}

/** Mints the state for one signed-in caller. */
export function createOAuthState(
  uid: string,
  options: { next?: string; now?: number } = {}
): GithubOAuthState {
  const now = options.now ?? Date.now();
  return {
    v: 1,
    uid,
    next: safeReturnPath(options.next),
    exp: now + STATE_TTL_MS,
  };
}

/** Signs a state so the callback can trust it without a server-side session. */
export function signOAuthState(state: GithubOAuthState): string | null {
  const key = tokenKey();
  if (!key) return null;
  return sign(state, key);
}

/**
 * Verifies and parses a state. Null for a bad signature, a bad shape, or an
 * expired state — the callback treats all three as "start again", never as a
 * partial claim about who is connecting.
 */
export function verifyOAuthState(
  raw: string | null | undefined,
  now = Date.now()
): GithubOAuthState | null {
  if (!raw) return null;
  const key = tokenKey();
  if (!key) return null;
  const value = verify<GithubOAuthState>(raw, key);
  if (!value || value.v !== 1) return null;
  if (typeof value.uid !== "string" || !value.uid) return null;
  if (typeof value.exp !== "number" || value.exp <= now) return null;
  return {
    v: 1,
    uid: value.uid.slice(0, 200),
    next: safeReturnPath(value.next),
    exp: value.exp,
  };
}

/** The redirect GitHub sends the browser back to. Must match exactly. */
export function oauthCallbackUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/github/oauth/callback`;
}

/** The consent screen for one state. */
export function authorizeUrl(
  config: GithubOAuthConfig,
  origin: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: oauthCallbackUrl(origin),
    scope: GITHUB_OAUTH_SCOPES,
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * The origin the browser is actually using.
 *
 * The callback URL has to be identical in both halves of the flow, and a
 * deployment behind a proxy sees its internal host in `req.url`. The forwarded
 * headers are what the browser typed, and they are the ones GitHub must send
 * the user back to.
 */
export function requestOrigin(req: {
  url: string;
  headers: Headers;
}): string {
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = req.headers.get("host")?.split(",")[0]?.trim();

  let protocol = forwardedProto || "";
  let host = forwardedHost || hostHeader || "";

  if (!protocol || !host) {
    try {
      const parsed = new URL(req.url);
      protocol = protocol || parsed.protocol.replace(":", "");
      host = host || parsed.host;
    } catch {
      // Fall through to the configured site URL below.
    }
  }

  if (!protocol || !host) {
    const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    if (configured) {
      try {
        const parsed = new URL(configured);
        protocol = protocol || parsed.protocol.replace(":", "");
        host = host || parsed.host;
      } catch {
        // Nothing usable; the caller reports a setup problem.
      }
    }
  }

  if (!host) return "";
  return `${protocol || "https"}://${host}`;
}

/**
 * GitHub's user tokens, old and new.
 *
 * OAuth App tokens are `gho_…` today, but GitHub still issues and accepts the
 * classic 40-character hexadecimal form, and an app installed before the prefix
 * existed will keep working. Both are long and opaque; a short string cannot be
 * a token.
 */
export function looksLikeGithubToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const token = value.trim();
  if (token.length < 20 || token.length > 255) return false;
  return /^[A-Za-z0-9_]+$/.test(token);
}

export type CodeExchange =
  | { ok: true; token: string; scopes: string }
  | { ok: false; reason: string };

/**
 * Trades the one-time `code` for an access token.
 *
 * GitHub answers 200 even for a failed exchange and puts the error in the body,
 * so the body is what decides — an `ok` response with no token is a failure,
 * not an empty success.
 */
export async function exchangeCode(
  config: GithubOAuthConfig,
  code: string,
  redirectUri: string,
  signal?: AbortSignal
): Promise<CodeExchange> {
  if (!code.trim()) return { ok: false, reason: "GitHub did not return a code." };

  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "openmi-repo-agent",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, reason: "GitHub could not be reached while finishing the connection." };
  }

  const payload = (await response.json().catch(() => null)) as
    | { access_token?: unknown; scope?: unknown; error?: unknown; error_description?: unknown }
    | null;

  if (!response.ok) {
    return { ok: false, reason: `GitHub returned HTTP ${response.status} while finishing the connection.` };
  }

  const token = payload?.access_token;
  if (!looksLikeGithubToken(token)) {
    const description =
      typeof payload?.error_description === "string" && payload.error_description
        ? payload.error_description
        : typeof payload?.error === "string" && payload.error
          ? payload.error
          : "GitHub did not return an access token.";
    return { ok: false, reason: description };
  }

  return {
    ok: true,
    token: token.trim(),
    scopes: typeof payload?.scope === "string" ? payload.scope.slice(0, 200) : GITHUB_OAUTH_SCOPES,
  };
}
