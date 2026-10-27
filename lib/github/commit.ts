// ── The one place Openmi writes to GitHub ────────────────────────────────────
//
// `lib/github/client.ts` is read-only by construction, and a test enforces that
// it stays that way. Everything that changes a repository lives here, so one
// grep answers "where can this product write?" and the answer is one file.
//
// The mechanics are the Git Data API, in the order that leaves no partial trace:
//
//   blob  →  tree (based on the base commit's tree)  →  commit  →  ref
//
// Nothing is observable on the repository until the ref is written, and that
// write is the atomic publish. A failure before it leaves four orphaned objects
// that GitHub garbage-collects and no branch, no commit on any branch, and
// nothing for a reviewer to find. The pull request is opened after the ref and
// its failure is reported rather than rolled back: the commit is real, and
// pretending otherwise would be a lie the repository contradicts.
//
// Three destinations are supported, and the caller has to name one:
//
//   pr      — an `agent/` branch, then a pull request against the default branch
//   branch  — the same branch, published on its own with no pull request
//   main    — the default branch itself, updated as a fast-forward
//
// The branch policy is checked here as well as derived upstream. Openmi reaches
// the default branch only when the person chose that destination; a bug that
// passes `main` as a branch name is still refused.

import type { CommitDestination } from "../types";
import { GithubError } from "./client";

const API_BASE = "https://api.github.com";

export interface CommitFile {
  path: string;
  /** The complete new contents. Base64 is applied here, not by the caller. */
  content: string;
}

export interface CommitInput {
  token: string;
  repoFullName: string;
  /** The commit the change was computed against. Also the parent. */
  baseSha: string;
  /** The `agent/` branch to create for the pr and branch destinations. */
  branch: string;
  message: string;
  files: CommitFile[];
  /** The branch a pull request targets, and the branch a main push updates. */
  defaultBranch: string;
  /** Where the commit goes. Defaults to a pull request. */
  destination?: CommitDestination;
  signal?: AbortSignal;
}

export interface CommitOutcome {
  sha: string;
  /** The branch the commit landed on: the agent branch, or the default branch. */
  branch: string;
  /** The pull request URL, or null when it could not be opened. */
  prUrl: string | null;
  /** Why a pull request is missing, when it is. Never a silent absence. */
  prError: string | null;
  /** Where the commit actually went. */
  destination: CommitDestination;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * One authenticated request.
 *
 * The error mapping is deliberately the same three cases as the read client —
 * dead token, rate limit, no permission — because those are the three things a
 * person can act on, and a commit that fails for an unknown reason is a support
 * ticket.
 */
async function request<T>(
  token: string,
  path: string,
  options: RequestOptions = {}
): Promise<{ data: T; status: number }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "openmi-repo-agent",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new GithubError(0, "GitHub could not be reached. Nothing was committed.");
  }

  if (response.ok) {
    const text = await response.text();
    return { data: (text ? JSON.parse(text) : null) as T, status: response.status };
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const resetAt = Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const detail = (await response.text().catch(() => "")).slice(0, 300);

  if (response.status === 401) {
    throw new GithubError(401, "GitHub rejected this connection. Reconnect GitHub and try again.");
  }
  if (response.status === 403 && remaining === "0") {
    throw new GithubError(429, "GitHub's rate limit for this connection is used up. Nothing was committed.", resetAt);
  }
  if (response.status === 403) {
    throw new GithubError(403, "This connection is not allowed to write to that repository. Nothing was committed.");
  }
  if (response.status === 404) {
    throw new GithubError(404, "That repository or branch is not available to this connection. Nothing was committed.");
  }
  if (response.status === 422 && path.includes("/git/refs")) {
    // A new ref collides with an existing branch; an updated ref was not a
    // fast-forward, which means the branch moved between the head check and
    // this write. Both mean nothing was published.
    throw new GithubError(
      409,
      path.includes("/git/refs/heads/")
        ? "The branch moved while this was being committed. Nothing was written; ask the agent to propose the change again."
        : "A branch with that name already exists. Nothing was committed."
    );
  }
  throw new GithubError(
    response.status,
    `GitHub refused the commit (HTTP ${response.status}).${detail ? ` ${detail}` : ""}`
  );
}

/** The tree sha of a commit, which is what `base_tree` needs. */
async function treeOfCommit(token: string, fullName: string, sha: string, signal?: AbortSignal): Promise<string> {
  const { data } = await request<{ tree?: { sha?: string } }>(
    token,
    `/repos/${fullName}/git/commits/${sha}`,
    { signal }
  );
  const tree = data?.tree?.sha;
  if (!tree || typeof tree !== "string") {
    throw new GithubError(502, "GitHub did not return the tree for that commit. Nothing was committed.");
  }
  return tree;
}

/** A ref name GitHub accepts, and one that cannot escape the refs path. */
function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 120 &&
    !name.includes("..") &&
    !name.startsWith("-") &&
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name)
  );
}

/**
 * Commits a change set where the reviewer chose it to go.
 *
 * Throws `GithubError` for anything GitHub refused; the route turns that into a
 * status and a sentence. A thrown error always means nothing was published —
 * with the one exception of a pull-request failure, which is reported in the
 * result because the commit itself already landed.
 */
export async function commitChanges(input: CommitInput): Promise<CommitOutcome> {
  const { token, repoFullName, baseSha, branch, message, files, defaultBranch, signal } = input;
  const destination = input.destination ?? "pr";

  // The policy, enforced where it matters rather than where it is convenient.
  // A pull request and a branch-only push may only create an `agent/` branch;
  // a direct push may only update the repository's own default branch.
  if (destination === "main") {
    if (!isSafeBranchName(defaultBranch) || defaultBranch.startsWith("agent/")) {
      throw new GithubError(403, "Openmi only pushes directly to the repository's own default branch.");
    }
  } else if (!/^agent\/[A-Za-z0-9._-]+$/.test(branch)) {
    throw new GithubError(403, "Openmi only commits to agent/ branches.");
  }
  if (files.length === 0) {
    throw new GithubError(400, "There is nothing to commit.");
  }
  // A path is a path, not a URL and not a way out of the repository. The
  // staging layer already refuses these; this is the boundary that has to hold
  // even if a change set row was hand-written.
  for (const file of files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("..") || file.path.includes("\\")) {
      throw new GithubError(400, "The change set contains a path outside the repository.");
    }
  }

  const baseTree = await treeOfCommit(token, repoFullName, baseSha, signal);

  const blobs: Array<{ path: string; sha: string }> = [];
  for (const file of files) {
    const { data } = await request<{ sha?: string }>(token, `/repos/${repoFullName}/git/blobs`, {
      method: "POST",
      body: {
        content: Buffer.from(file.content, "utf8").toString("base64"),
        encoding: "base64",
      },
      signal,
    });
    if (!data?.sha) {
      throw new GithubError(502, "GitHub did not accept one of the changed files. Nothing was committed.");
    }
    blobs.push({ path: file.path, sha: data.sha });
  }

  const { data: tree } = await request<{ sha?: string }>(token, `/repos/${repoFullName}/git/trees`, {
    method: "POST",
    body: {
      base_tree: baseTree,
      tree: blobs.map((blob) => ({
        path: blob.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      })),
    },
    signal,
  });
  if (!tree?.sha) {
    throw new GithubError(502, "GitHub did not create the new tree. Nothing was committed.");
  }

  const { data: commit } = await request<{ sha?: string }>(token, `/repos/${repoFullName}/git/commits`, {
    method: "POST",
    body: { message, tree: tree.sha, parents: [baseSha] },
    signal,
  });
  if (!commit?.sha) {
    throw new GithubError(502, "GitHub did not create the commit. Nothing was committed.");
  }

  // The publish. Everything before this is invisible; everything after it is
  // history, which is why nothing after it is allowed to throw away the sha.
  // A main push updates the existing default branch ref and must stay a
  // fast-forward, so it is sent without force; GitHub refuses anything else.
  if (destination === "main") {
    await request<unknown>(token, `/repos/${repoFullName}/git/refs/heads/${defaultBranch}`, {
      method: "PATCH",
      body: { sha: commit.sha, force: false },
      signal,
    });
  } else {
    await request<unknown>(token, `/repos/${repoFullName}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
      signal,
    });
  }

  let prUrl: string | null = null;
  let prError: string | null = null;
  if (destination === "pr") {
    try {
      const { data: pull } = await request<{ html_url?: string }>(token, `/repos/${repoFullName}/pulls`, {
        method: "POST",
        body: {
          title: message,
          head: branch,
          base: input.defaultBranch,
          body: [
            "Proposed by Openmi from a reviewed change set.",
            "",
            `Base commit: \`${baseSha.slice(0, 12)}\``,
            `Files: ${files.map((file) => `\`${file.path}\``).join(", ")}`,
          ].join("\n"),
          maintainer_can_modify: true,
        },
        signal,
      });
      if (typeof pull?.html_url === "string") prUrl = pull.html_url;
      else prError = "GitHub created the branch but did not return a pull request link.";
    } catch (error) {
      // The branch exists; the pull request does not. Saying the whole commit
      // failed would be wrong, so the reason travels back with the sha.
      prError = error instanceof GithubError ? error.message : "The pull request could not be opened.";
    }
  }

  return {
    sha: commit.sha,
    branch: destination === "main" ? defaultBranch : branch,
    prUrl,
    prError,
    destination,
  };
}
