// ── Turning a GitHub tree into something an agent can use ────────────────────
//
// A recursive tree of a real repository is thousands of entries, most of them
// noise: build output, dependencies, generated files. Handing that to a model
// is both expensive and counterproductive — the two files that matter get lost
// in ten thousand that do not.
//
// This module is pure. It has no token, no network and no environment, which is
// what makes the filtering rules testable and stable.

import type { GithubTreeEntry } from "./client";

/**
 * Directories that are never part of the source a person means.
 *
 * Deliberately conservative: `dist` and `build` are here because reading them
 * produces confident answers about generated code, but a project that keeps
 * hand-written files in `build` is rare enough to be worth the trade.
 */
export const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "Pods",
  ".gradle",
  ".idea",
]);

/** Individual files that are noise or too large to read usefully. */
const IGNORED_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
]);

/** The largest blob the agent will open. Past this it is generated or data. */
export const MAX_FILE_BYTES = 200_000;

/** How many paths the file-list tool may return in one call. */
export const MAX_TREE_PATHS = 600;

/**
 * How many source files the agent is given up front.
 *
 * The agent does not start with the whole repository in context. It starts from
 * a bounded file list and reads only the files it chooses. This keeps the first
 * model call from being large on big repositories and is the main guard against
 * sending too much repo in one go.
 *
 * Browser/file viewers still use `MAX_TREE_PATHS`, which can be larger.
 */
export const MAX_AGENT_FILES = 80;

/** A file the agent may read. */
export interface TreeFile {
  path: string;
  sha: string;
  size: number;
}

/**
 * True when a path is relative, normalised, and inside the repository.
 *
 * This is the only place a model-supplied path is allowed to become a real
 * request. Rejecting `..`, absolute paths, backslashes and NUL bytes here means
 * every caller below inherits the guarantee.
 */
export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (!path || path.length > 400) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return false;
  return true;
}

/** True when any segment of the path is a directory we never show. */
export function isIgnoredPath(path: string): boolean {
  const segments = path.split("/");
  const file = segments[segments.length - 1] ?? "";
  if (IGNORED_FILES.has(file)) return true;
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment));
}

/** True when a file's name suggests it is not human-written source. */
function looksGenerated(path: string): boolean {
  const file = path.split("/").pop() ?? path;
  return (
    file.endsWith(".min.js") ||
    file.endsWith(".min.css") ||
    file.endsWith(".map") ||
    file.endsWith(".snap") ||
    file.endsWith(".lock") ||
    file.endsWith(".svg") ||
    file.endsWith(".png") ||
    file.endsWith(".jpg") ||
    file.endsWith(".jpeg") ||
    file.endsWith(".gif") ||
    file.endsWith(".webp") ||
    file.endsWith(".ico") ||
    file.endsWith(".pdf") ||
    file.endsWith(".woff") ||
    file.endsWith(".woff2") ||
    file.endsWith(".ttf")
  );
}

export interface FilteredTree {
  files: TreeFile[];
  /** Total blobs before the ignore rules and the cap. */
  total: number;
  /** True when the cap removed files the agent will not see. */
  truncated: boolean;
  /** True when GitHub itself truncated the recursive tree. */
  githubTruncated: boolean;
}

/**
 * Filters a tree down to readable source files.
 *
 * The cap counts *kept* files, so a repository full of build output still
 * returns a useful list. When it does truncate, `truncated` says so rather than
 * letting the model believe it has seen the whole repository.
 *
 * The agent path uses a tighter cap than the file-list pane, because the agent
 * should not start inside a large working set.
 */
export function filterTree(
  entries: GithubTreeEntry[],
  githubTruncated = false,
  maxPaths = MAX_TREE_PATHS
): FilteredTree {
  const all = entries.filter((entry) => entry.type === "blob" && isSafeRelativePath(entry.path));
  const readable = all.filter((entry) => !isIgnoredPath(entry.path) && !looksGenerated(entry.path));

  const files: TreeFile[] = [];
  for (const entry of readable) {
    if (files.length >= maxPaths) break;
    files.push({ path: entry.path, sha: entry.sha, size: typeof entry.size === "number" ? entry.size : 0 });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    total: all.length,
    truncated: readable.length > files.length,
    githubTruncated,
  };
}

/** The directories implied by a file list, for the pane. */
export function directoriesOf(files: TreeFile[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  }
  return [...dirs].sort();
}

/**
 * Ranks paths against a query, best first.
 *
 * The scoring is deliberately simple and explainable: an exact file name beats
 * a prefix, which beats a directory or path match. That is enough to pick
 * candidates to open, and it never hides why a file was chosen.
 */
export function rankPaths(files: TreeFile[], query: string, limit = 40): TreeFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice(0, limit);
  const terms = needle.split(/\s+/).filter(Boolean).slice(0, 6);

  const scored = files.map((file) => {
    const path = file.path.toLowerCase();
    const name = path.split("/").pop() ?? path;
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 100;
      else if (name.startsWith(term)) score += 60;
      else if (name.includes(term)) score += 40;
      else if (path.includes(term)) score += 20;
      else if (path.split(/[/._-]/).some((part) => part.startsWith(term))) score += 10;
    }
    // A shorter path is a more likely answer when scores are equal.
    return { file, score, depth: path.split("/").length };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.file.path.localeCompare(b.file.path))
    .slice(0, limit)
    .map((entry) => entry.file);
}
