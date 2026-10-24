// Personal access tokens — a stored GitHub credential the owner can paste in.

/** The classic scope the agent needs. Fine-grained tokens use permissions instead. */
export const PAT_SCOPE_HINT = "repo";

/** Matches the length the database validates on a stored label. */
export const CONNECTION_LABEL_MAX = 40;

export type ConnectionKind = "pat" | "oauth";

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
 * What a person should do about a token that cannot do its job.
 *
 * Returned only when there is something to fix, so `null` is the good state.
 * The panel renders this as a card with the scope spelled out and a link to the
 * page where the token is edited: "the agent cannot read repositories" is a
 * dead end on its own, and the two things that resolve it are a name to copy and
 * a place to paste it.
 *
 * The scope text is written the way each kind of token presents it, because
 * `repo` does not exist on a fine-grained token and looking for it there is how
 * someone ends up creating the same broken token twice.
 */
export interface PatRecovery {
  /** `blocked` cannot read anything; `limited` can read, but less than expected. */
  level: "blocked" | "limited";
  headline: string;
  body: string;
  /** The exact classic scope to add. */
  classicScope: string;
  /** The exact fine-grained permissions to add, in GitHub's own wording. */
  fineGrained: string[];
  /** Where a classic token is created or edited. */
  tokenUrl: string;
  /** Where a fine-grained token is created. */
  fineGrainedUrl: string;
}

const TOKEN_URL = "https://github.com/settings/tokens";
const FINE_GRAINED_URL = "https://github.com/settings/personal-access-tokens/new";

function recovery(
  level: PatRecovery["level"],
  headline: string,
  body: string
): PatRecovery {
  return {
    level,
    headline,
    body,
    classicScope: PAT_SCOPE_HINT,
    fineGrained: ["Contents: Read", "Metadata: Read"],
    tokenUrl: TOKEN_URL,
    fineGrainedUrl: FINE_GRAINED_URL,
  };
}

/**
 * The recovery for one token, or null when it needs none.
 *
 * The strongest fact wins: a failed repository listing is reported ahead of a
 * thin scope header, because the header is advisory and the probe is not.
 */
export function recoveryFor(input: {
  scopes: string[];
  canReadRepos: boolean;
}): PatRecovery | null {
  const { scopes, canReadRepos } = input;

  if (!canReadRepos) {
    return recovery(
      "blocked",
      "This token cannot read repositories",
      "GitHub accepted it, but would not let it list a single repository, so the agent cannot read any repository with it. Add the scope below to the token on GitHub, then replace this connection with the new one."
    );
  }

  // An empty list means GitHub reported no classic scopes — a fine-grained
  // token, whose access the probe already proved. Nothing to fix.
  if (scopes.length === 0) return null;
  if (scopes.includes("repo")) return null;

  if (scopes.includes("public_repo")) {
    return recovery(
      "limited",
      "This token only reaches public repositories",
      "It can read public repositories, but private ones will not appear in the list until it has the scope below. Add it on GitHub, then replace this connection with the new token."
    );
  }

  return recovery(
    "limited",
    "This token is missing repository scopes",
    "It has no repository scope at all, so the repositories it can reach may not include the one you pick. Add the scope below on GitHub, then replace this connection with the new token."
  );
}

/**
 * Turns what the token can do into the one sentence worth showing.
 *
 * Order matters: the strongest fact wins. A token that cannot list a single
 * repository is the important thing to say even if its scope header also looks
 * thin, because the scope header is advisory and the failed probe is not.
 */
/**
 * The one-line version of the same judgement, for a response body.
 *
 * Composed from `recoveryFor` rather than written out again, so the panel's
 * card and the API's message can never disagree about what is wrong or which
 * scope fixes it.
 */
export function assessPat(input: { scopes: string[]; canReadRepos: boolean }): PatAssessment {
  const found = recoveryFor(input);
  return {
    canReadRepos: input.canReadRepos,
    scopes: input.scopes,
    warning: found ? found.body : null,
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
