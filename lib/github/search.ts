// ── Searching a repository without a search service ─────────────────────────
//
// GitHub's code-search endpoint is rate limited far more tightly than the REST
// API, and it is not available for every account. Relying on it would make the
// agent's basic "where is this" question fail for the people most likely to be
// on a small plan.
//
// So the search runs here, over files the server has already fetched, and it is
// bounded in all three directions that cost money: how many files are opened,
// how large each may be, and how many hits come back. A search that cannot
// promise those bounds is a search that can quietly spend a whole turn's budget
// on one query.
//
// Pure and synchronous, so the ranking rules are testable without a network.

import { MAX_FILE_BYTES, type TreeFile } from "./tree";

export interface SearchableFile {
  path: string;
  text: string;
  /** Size on disk, used to skip generated giants. */
  size: number;
}

export interface SearchHit {
  path: string;
  /** 1-based, so it matches what an editor shows. */
  line: number;
  /** The matching line, trimmed to a readable width. */
  text: string;
}

/** The longest line fragment returned for one hit. */
const MAX_HIT_CHARS = 180;
/** Hits in one result. */
const MAX_HITS = 20;
/** Hits from one file, so one large match cannot crowd out the rest. */
const MAX_HITS_PER_FILE = 3;

/**
 * Literal, case-insensitive search.
 *
 * Not a regex: the query comes from a model, and a model-written regex is one
 * catastrophic backtrack away from hanging the request. Substring matching is
 * dumber and predictable, which is the right trade here.
 */
export function searchFiles(
  files: SearchableFile[],
  query: string,
  maxHits = MAX_HITS
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length > 200) return [];

  const hits: SearchHit[] = [];
  for (const file of files) {
    if (hits.length >= maxHits) break;
    if (!file.text || file.size > MAX_FILE_BYTES) continue;

    let perFile = 0;
    const lines = file.text.split(/\r?\n/);
    for (let index = 0; index < lines.length && perFile < MAX_HITS_PER_FILE; index += 1) {
      const line = lines[index]!;
      if (!line.toLowerCase().includes(needle)) continue;
      hits.push({
        path: file.path,
        line: index + 1,
        text: line.trim().slice(0, MAX_HIT_CHARS),
      });
      perFile += 1;
      if (hits.length >= maxHits) break;
    }
  }
  return hits;
}

/**
 * Which files are worth opening for a query.
 *
 * Path matches first — a query for "auth" should open `auth.ts` before it opens
 * a file that merely mentions the word — then files with no path signal at all
 * are not opened. This keeps a query affordable: at most `limit` blobs.
 */
export function pickSearchCandidates(files: TreeFile[], query: string, limit = 30): TreeFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const terms = needle.split(/\s+/).filter(Boolean).slice(0, 6);

  const scored = files
    .filter((file) => file.size > 0 && file.size <= MAX_FILE_BYTES)
    .map((file) => {
      const path = file.path.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (path.includes(term)) score += 5;
      }
      return { file, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  return scored.slice(0, limit).map((entry) => entry.file);
}

/** A compact line for the transcript, so the model sees path:line:text. */
export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No matches.";
  return hits.map((hit) => `${hit.path}:${hit.line}: ${hit.text}`).join("\n");
}
