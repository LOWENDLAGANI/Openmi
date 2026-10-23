// ── Personal access tokens, and the connections they make ───────────────────
//
// GitHub has two ways to give this app a credential. The OAuth App door asks
// GitHub to hand one over; the token door asks the *person* to make one at
// github.com/settings/tokens and paste it. The second door needs no client
// secret, no callback URL and no round trip, which is exactly why it is here:
// when the OAuth flow is the thing that is broken in an environment, a token
// path that only needs a `GET /user` is a door that still opens.
//
// A token is not a better credential than an OAuth grant — it is a longer-lived
// one, and the person revokes it on GitHub rather than in this app. What the two
// share is the part that matters: the secret is sealed with the deployment key
// before it is stored, never returned to the browser, and never chosen by the
// client. Everything in this module is pure except the id, which is a hash.
//
// ── The scope question ───────────────────────────────────────────────────────
// The agent reads repositories. A token that cannot read any is useless to it,
// and a token that can only read public ones is useful for a smaller set of
// repositories than the person probably meant. Both are worth saying out loud —
// and neither is worth refusing, because the person may be about to add the
// scope, or may only want this connection for a public repository. So the door
// stores what it is given and returns a warning to put on screen. Blocking here
// would turn a recoverable mistake into a dead end.

import { createHash } from "node:crypto";

/** The classic scope the agent needs. Fine-grained tokens use permissions instead. */
export const PAT_SCOPE_HINT = "repo";

/** Matches the length the database rules validate on a stored label. */
export const CONNECTION_LABEL_MAX = 40;

export type ConnectionKind = "pat" | "oauth";

/**
 * A stable id for one GitHub account's connection.
 *
 * Derived from the login so reconnecting the same account *replaces* its entry
 * instead of adding a second one — a new token for the same person is a
 * rotated credential, not a new connection. Two GitHub accounts on one Openmi
 * account are two entries, which is the point of storing a collection.
 */
export function connectionIdFor(login: string): string {
  return createHash("sha256").update(login.trim().toLowerCase()).digest("hex").slice(0, 12);
}

/** True when a URL segment could be one of our connection ids. */
export function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}

export function normalizeConnectionLabel(value: unknown, fallback = "GitHub"): string {
  const trimmed = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (trimmed || fallback).slice(0, CONNECTION_LABEL_MAX);
}

export function normalizeConnectionKind(value: unknown): ConnectionKind {
  return value === "oauth" ? "oauth" : "pat";
}

/**
 * Splits GitHub's `x-oauth-scopes` header into scope names.
 *
 * Classic tokens report this as a comma-separated list. Fine-grained tokens
 * report nothing at all — their permissions are not expressible in the classic
 * vocabulary — so an empty array here means "GitHub did not say", not "no
 * scopes". The two are told apart by whether the header was present, which is
 * what `readScopeHeader` preserves.
 */
export function parseScopes(header: string | null | undefined): string[] {
  if (typeof header !== "string" || !header.trim()) return [];
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

export interface PatAssessment {
  /** Whether GitHub let this token list a repository at all. */
  canReadRepos: boolean;
  /** What GitHub reported, when it reports classic scopes. */
  scopes: string[];
  /**
   * A sentence for the interface, or null when the token is exactly what the
   * agent needs. Nothing is refused on the strength of this.
   */
  warning: string | null;
}

/**
 * Turns what the token can do into the one sentence worth showing.
 *
 * Order matters: the strongest fact wins. A token that cannot list a single
 * repository is the important thing to say even if its scope header also looks
 * thin, because the scope header is advisory and the failed probe is not.
 */
export function assessPat(input: { scopes: string[]; canReadRepos: boolean }): PatAssessment {
  const { scopes, canReadRepos } = input;

  if (!canReadRepos) {
    return {
      canReadRepos,
      scopes,
      warning:
        "This token can identify you on GitHub but cannot read any repository, so the agent cannot use it yet. Grant the `repo` scope on a classic token, or Contents: read plus Metadata: read on a fine-grained token, then connect it again.",
    };
  }

  // An empty list means GitHub did not report classic scopes — a fine-grained
  // token. The probe already proved it can read something, so there is nothing
  // to warn about from a header that does not exist.
  if (scopes.length === 0) return { canReadRepos, scopes, warning: null };

  if (scopes.includes("repo")) return { canReadRepos, scopes, warning: null };

  if (scopes.includes("public_repo")) {
    return {
      canReadRepos,
      scopes,
      warning:
        "This token can only read public repositories. Private ones will not appear until it has the `repo` scope.",
    };
  }

  return {
    canReadRepos,
    scopes,
    warning:
      "This token has no `repo` or `public_repo` scope. It can reach the repositories it was granted, but the agent may not be able to read the ones you pick.",
  };
}

/** How the connection list describes a token's reach. */
export function describeScopes(scopes: string[], canReadRepos: boolean): string {
  if (scopes.length === 0) {
    return canReadRepos ? "fine-grained" : "no repository access";
  }
  if (scopes.includes("repo")) return "read and write repositories";
  if (scopes.includes("public_repo")) return "public repositories only";
  return scopes.slice(0, 3).join(", ");
}
