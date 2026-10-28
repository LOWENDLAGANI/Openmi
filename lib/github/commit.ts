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
// Nothing is observable on the repository until the ref is created, and the ref
// is the atomic publish. A failure before it leaves four orphaned objects that
// GitHub garbage-collects and no branch, no commit on any branch, and nothing
// for a reviewer to find. The pull request is opened after the ref and its
// failure is reported rather than rolled back: the commit is real, and pretending
// otherwise would be a lie the repository contradicts.
//
// The branch is checked here as well as derived upstream. `main` is one bug away
// from being a branch name, and this is the last place that can refuse it.

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
  branch: string;
  message: string;
  files: CommitFile[];
  defaultBranch: string;
  /** False when the caller only wants the branch and commit. */
  openPullRequest?: boolean;
  signal?: AbortSignal;
}

export interface CommitOutcome {
  sha: string;
  branch: string;
  /** The pull request URL, or null when it could not be opened. */
  prUrl: string | null;
  /** Why a pull request is missing, when it is. Never a silent absence. */
  prError: string | null;
}

interface RequestOptions {
  method?: "GET" | "POST";
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
  if (response.status === 422 && path.endsWith("/git/refs")) {
    throw new GithubError(409, "A branch with that name already exists. Nothing was committed.");
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

/**
 * Commits a change set to its `agent/` branch and opens a pull request.
 *
 * Throws `GithubError` for anything GitHub refused; the route turns that into a
 * status and a sentence. A thrown error always means no ref was created — with
 * the one exception of a pull-request failure, which is reported in the result
 * because the commit itself already landed.
 */
export async function commitChanges(input: CommitInput): Promise<CommitOutcome> {
  const { token, repoFullName, baseSha, branch, message, files, signal } = input;

  // The policy, enforced where it matters rather than where it is convenient.
  if (!/^agent\/[A-Za-z0-9._-]+$/.test(branch)) {
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
  await request<unknown>(token, `/repos/${repoFullName}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    signal,
  });

  let prUrl: string | null = null;
  let prError: string | null = null;
  if (input.openPullRequest !== false) {
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

  return { sha: commit.sha, branch, prUrl, prError };
}
