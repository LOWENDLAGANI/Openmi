// ── GitHub REST, the little we need ──────────────────────────────────────────
//
// Server-only. Every call takes the token explicitly rather than reading it from
// the environment, because the token belongs to one signed-in person and is read
// from their sealed record per request.
//
// Read-only by construction: the functions here only GET. The commit path in
// Phase 2 will be a separate module so a grep for a write method in this file
// stays meaningful.
//
// Two behaviours matter more than the endpoints:
//
//   - A 403 with `x-ratelimit-remaining: 0` is a rate limit, not a permission
//     error, and its reset time is in a header. Reporting both the same way
//     sends a user to reconnect GitHub for a problem that only needs waiting.
//   - A 401 always means the stored token is dead. The caller's remedy is to
//     reconnect, and the message says so.

const API_BASE = "https://api.github.com";

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Epoch ms when a rate limit lifts, when GitHub told us. */
    readonly resetAt?: number
  ) {
    super(message);
    this.name = "GithubError";
  }
}

export interface GithubViewer {
  login: string;
  id: number;
  name: string | null;
}

export interface GithubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  updated_at?: string;
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GithubTree {
  /** The commit the tree was read at, which is what a change set is based on. */
  sha: string;
  entries: GithubTreeEntry[];
  /** GitHub caps a recursive tree; a truncated result is not a complete list. */
  truncated: boolean;
}

/** True when a string is `owner/name` and nothing more. */
export function normalizeRepoFullName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (value.length > 140) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return null;
  if (value.includes("..") || value.startsWith("/") || value.endsWith("/")) return null;
  return value;
}

function resetFrom(headers: Headers): number | undefined {
  const reset = headers.get("x-ratelimit-reset");
  if (!reset) return undefined;
  const seconds = Number(reset);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

async function githubFetch<T>(token: string, path: string, init?: RequestInit): Promise<{ data: T; headers: Headers }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "openmi-repo-agent",
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new GithubError(0, "GitHub could not be reached. Check the connection and try again.");
  }

  if (response.ok) {
    const data = (await response.json()) as T;
    return { data, headers: response.headers };
  }

  const resetAt = resetFrom(response.headers);
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (response.status === 401) {
    throw new GithubError(401, "GitHub rejected this connection. Reconnect GitHub and try again.");
  }
  if (response.status === 403 && remaining === "0") {
    throw new GithubError(
      429,
      "GitHub's rate limit for this connection is used up. Try again in a few minutes.",
      resetAt
    );
  }
  if (response.status === 403) {
    throw new GithubError(403, "This connection is not allowed to read that repository.");
  }
  if (response.status === 404) {
    throw new GithubError(404, "That repository or file is not available to this connection.");
  }
  if (response.status === 429) {
    throw new GithubError(429, "GitHub is rate limiting this connection. Try again shortly.", resetAt);
  }
  throw new GithubError(
    response.status,
    `GitHub returned HTTP ${response.status}. Try again, or reconnect GitHub if this keeps happening.`
  );
}

/** The account the token belongs to. */
export async function getViewer(token: string): Promise<GithubViewer> {
  const { data } = await githubFetch<GithubViewer>(token, "/user");
  return data;
}

/**
 * The repositories this person can read, newest first.
 *
 * `affiliation` is explicit so an organisation repository shows up without the
 * user having to star it or search for it.
 */
export async function listRepos(token: string): Promise<GithubRepo[]> {
  const { data } = await githubFetch<GithubRepo[]>(
    token,
    "/user/repos?sort=updated&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member"
  );
  if (!Array.isArray(data)) return [];
  return data
    .filter((repo) => repo && typeof repo.full_name === "string")
    .map((repo) => ({
      id: repo.id,
      full_name: repo.full_name,
      name: repo.name,
      private: Boolean(repo.private),
      default_branch: repo.default_branch || "main",
      owner: { login: repo.owner?.login ?? repo.full_name.split("/")[0]! },
      permissions: repo.permissions,
      updated_at: repo.updated_at,
    }));
}

/** One repository, including whether this token may push to it. */
export async function getRepo(token: string, fullName: string): Promise<GithubRepo> {
  const { data } = await githubFetch<GithubRepo>(token, `/repos/${fullName}`);
  if (!data || typeof data.full_name !== "string") {
    throw new GithubError(404, "That repository is not available to this connection.");
  }
  return data;
}

/** The commit the named branch points at right now. */
export async function getBranchHead(token: string, fullName: string, branch: string): Promise<string> {
  const { data } = await githubFetch<{ object?: { sha?: string } }>(
    token,
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`
  );
  const sha = data?.object?.sha;
  if (!sha || typeof sha !== "string") {
    throw new GithubError(502, "GitHub did not return a commit for that branch.");
  }
  return sha;
}

/**
 * The full tree at a commit.
 *
 * `sha` in the result is the commit that was asked for, not the tree object's
 * own sha: a change set is based on a commit, and reporting anything else here
 * would make the base recorded by the project differ from the one the model
 * read.
 */
export async function getTree(token: string, fullName: string, sha: string): Promise<GithubTree> {
  const { data } = await githubFetch<{
    tree?: GithubTreeEntry[];
    truncated?: boolean;
  }>(token, `/repos/${fullName}/git/trees/${sha}?recursive=1`);

  const entries = Array.isArray(data?.tree)
    ? data.tree.filter(
        (entry) =>
          entry &&
          typeof entry.path === "string" &&
          typeof entry.sha === "string" &&
          (entry.type === "blob" || entry.type === "tree" || entry.type === "commit")
      )
    : [];

  return { sha, entries, truncated: Boolean(data?.truncated) };
}

/** A blob's text, or null when it is binary or larger than the cap. */
export async function getBlobText(
  token: string,
  fullName: string,
  sha: string,
  maxBytes = 256_000
): Promise<{ text: string; truncated: boolean } | null> {
  const { data } = await githubFetch<{ content?: string; encoding?: string; size?: number }>(
    token,
    `/repos/${fullName}/git/blobs/${sha}`
  );
  if (!data || typeof data.content !== "string") return null;
  // The blob API base64-encodes with newlines.
  const raw = Buffer.from(data.content.replace(/\n/g, ""), "base64");
  const truncated = raw.length > maxBytes;
  const slice = truncated ? raw.subarray(0, maxBytes) : raw;
  // A NUL byte is the cheapest reliable "this is not text" signal.
  if (slice.includes(0)) return null;
  const text = slice.toString("utf8");
  // A replacement character in the first kilobyte is a decode failure, not text.
  if (text.slice(0, 1024).includes("\uFFFD")) return null;
  return { text, truncated };
}
