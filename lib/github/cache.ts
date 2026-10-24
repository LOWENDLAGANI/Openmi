// Short-lived cache for repository reads — two minutes, bounded.

import { createHash } from "node:crypto";
import { getBlobText, getTree, type GithubTree } from "./client";

const TTL_MS = 120_000;
const MAX_TREES = 12;
const MAX_BLOBS = 200;

interface Entry<T> {
  at: number;
  value: T;
}

const trees = new Map<string, Entry<GithubTree>>();
const blobs = new Map<string, Entry<{ text: string; truncated: boolean } | null>>();

/**
 * The access scope a cached read belongs to.
 *
 * Keying only by repository and sha shares one person's read with everyone
 * else, and for a private repository that is a disclosure: somebody whose
 * access was revoked — or who simply knows the name and commit — would be
 * served the bytes another account fetched, because the cache is consulted
 * before GitHub is ever asked. A hash of the token keeps each connection's
 * reads to itself without storing the token as a key.
 */
function scopeFor(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function fresh<T>(entry: Entry<T> | undefined, now: number): boolean {
  return Boolean(entry && now - entry.at < TTL_MS);
}

function prune<T>(map: Map<string, Entry<T>>, limit: number, now: number): void {
  for (const [key, entry] of map) {
    if (now - entry.at >= TTL_MS) map.delete(key);
  }
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** The tree at a commit, cached for two minutes. */
export async function loadTree(token: string, fullName: string, sha: string): Promise<GithubTree> {
  const key = `${scopeFor(token)}:${fullName}@${sha}`;
  const now = Date.now();
  const hit = trees.get(key);
  if (fresh(hit, now) && hit) return hit.value;
  const tree = await getTree(token, fullName, sha);
  trees.set(key, { at: now, value: tree });
  prune(trees, MAX_TREES, now);
  return tree;
}

/** One blob, cached by its own sha so a re-read after an edit is not stale. */
export async function loadBlob(
  token: string,
  fullName: string,
  sha: string
): Promise<{ text: string; truncated: boolean } | null> {
  const key = `${scopeFor(token)}:${fullName}@${sha}`;
  const now = Date.now();
  const hit = blobs.get(key);
  if (fresh(hit, now)) return hit!.value;
  const blob = await getBlobText(token, fullName, sha);
  blobs.set(key, { at: now, value: blob });
  prune(blobs, MAX_BLOBS, now);
  return blob;
}

/** Exposed for tests and for the admin diagnostics route. */
export function clearRepoCache(): void {
  trees.clear();
  blobs.clear();
}
