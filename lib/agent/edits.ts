// ── Proposals, and the diffs that describe them ─────────────────────────────
//
// `propose_edits` is the agent's only change-shaped tool, and it is not a write.
// It turns a model's intent into a staged, reviewable change: the text after
// the edit, plus a unified diff computed *here*, from the file the agent read
// and the result of applying the edit.
//
// Two rules follow from that and are worth stating because they are the whole
// reason this module is pure and separate:
//
//   1. A diff is derived, never accepted. The model has no way to hand us a
//      diff or an "after" blob; it can only name a path and either say what the
//      file should contain or what substring to replace. Everything a reviewer
//      will see is computed from the base commit's own bytes.
//   2. Nothing here reaches GitHub. There is no token, no fetch and no import
//      from `lib/github/client` — only the path rules from `tree.ts`. The
//      change lives in memory until the approval path (a later slice) commits
//      it, so an injected repository instruction still cannot change anything.
//
// The edit shapes are the two from the spec: a whole file, or a unique
// `old_string` → `new_string` replacement. A replacement that matches zero or
// several places is refused rather than guessed at, because "apply it
// somewhere" is how an agent silently edits the wrong function.

import { isIgnoredPath, isSafeRelativePath } from "@/lib/github/tree";

/** How many files one call may propose. Keeps one turn's review readable. */
export const MAX_EDITS_PER_CALL = 6;
/** The largest file a proposal may produce, in UTF-8 bytes. */
export const MAX_EDIT_BYTES = 120_000;
/** A diff past this is refused: a change that big cannot be reviewed properly. */
export const MAX_DIFF_CHARS = 60_000;
/**
 * Above this many lines on either side, the alignment table is skipped and the
 * change is shown as a whole-block replacement. Still a truthful diff, just not
 * a minimal one — and it bounds the work a single call can do.
 */
export const MAX_DIFF_LINES = 2_000;
/** Context lines around a change, the unified-diff default. */
const CONTEXT_LINES = 3;

const NO_NEWLINE = "\\ No newline at end of file";

export type ChangeKind = "modified" | "created";

/** One proposed file, ready for a review screen and a commit. */
export interface StagedChange {
  path: string;
  kind: ChangeKind;
  /** Lines added and removed, counted from the computed diff. */
  added: number;
  removed: number;
  /** Unified diff, derived from `before` and `after`. Never model-supplied. */
  diff: string;
  /** The complete file after the edit, so a commit needs no second read. */
  after: string;
  /** Size of `after` in UTF-8 bytes. */
  bytes: number;
}

/** An edit that was not staged, with the reason the model is told. */
export interface EditRejection {
  path: string;
  reason: string;
}

/** The base commit's text for a path, as the read tools already return it. */
export interface EditBase {
  text: string;
  truncated: boolean;
}

/**
 * What staging needs from the repository, and nothing more.
 *
 * Deliberately not a token or a client: the tool cannot write because it has
 * nothing to write with.
 */
export interface EditContext {
  /** The current text of a file at the base commit, or null when unreadable. */
  readBase(path: string): Promise<EditBase | null>;
  /** True when the path exists in the tree the agent was given. */
  exists(path: string): boolean;
}

export interface StagedSet {
  changes: StagedChange[];
  rejected: EditRejection[];
}

// ── Diffing ─────────────────────────────────────────────────────────────────

interface DiffRow {
  type: " " | "-" | "+";
  text: string;
  /** 0-based line in the old file, when the row has one. */
  oldIndex?: number;
  /** 0-based line in the new file, when the row has one. */
  newIndex?: number;
}

interface SplitText {
  lines: string[];
  /** False when the text does not end in a newline, which diff tooling marks. */
  finalNewline: boolean;
}

/** Splits on newlines and keeps a trailing `\r`, so CRLF text round-trips. */
function splitLines(text: string): SplitText {
  if (!text) return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), finalNewline };
}

/**
 * Aligns two line arrays into a row script.
 *
 * Common prefix and suffix are trimmed first — for a small edit in a large file
 * that is nearly all of the work — then the middle is aligned with a longest
 * common subsequence. The table is the reason for `MAX_DIFF_LINES`: past it the
 * middle is reported as a replacement, which is correct even when it is not
 * minimal.
 */
function diffRows(before: string[], after: string[]): DiffRow[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows: DiffRow[] = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ type: " ", text: before[index]!, oldIndex: index, newIndex: index });
  }

  const oldMiddle = before.slice(prefix, before.length - suffix);
  const newMiddle = after.slice(prefix, after.length - suffix);

  if (oldMiddle.length > MAX_DIFF_LINES || newMiddle.length > MAX_DIFF_LINES) {
    oldMiddle.forEach((line, offset) => rows.push({ type: "-", text: line, oldIndex: prefix + offset }));
    newMiddle.forEach((line, offset) => rows.push({ type: "+", text: line, newIndex: prefix + offset }));
  } else {
    const table: Uint16Array[] = Array.from(
      { length: oldMiddle.length + 1 },
      () => new Uint16Array(newMiddle.length + 1)
    );
    for (let old = oldMiddle.length - 1; old >= 0; old -= 1) {
      const row = table[old]!;
      const next = table[old + 1]!;
      for (let fresh = newMiddle.length - 1; fresh >= 0; fresh -= 1) {
        row[fresh] =
          oldMiddle[old] === newMiddle[fresh]
            ? next[fresh + 1]! + 1
            : Math.max(next[fresh]!, row[fresh + 1]!);
      }
    }

    let old = 0;
    let fresh = 0;
    while (old < oldMiddle.length && fresh < newMiddle.length) {
      if (oldMiddle[old] === newMiddle[fresh]) {
        rows.push({ type: " ", text: oldMiddle[old]!, oldIndex: prefix + old, newIndex: prefix + fresh });
        old += 1;
        fresh += 1;
      } else if (table[old + 1]![fresh]! >= table[old]![fresh + 1]!) {
        rows.push({ type: "-", text: oldMiddle[old]!, oldIndex: prefix + old });
        old += 1;
      } else {
        rows.push({ type: "+", text: newMiddle[fresh]!, newIndex: prefix + fresh });
        fresh += 1;
      }
    }
    while (old < oldMiddle.length) {
      rows.push({ type: "-", text: oldMiddle[old]!, oldIndex: prefix + old });
      old += 1;
    }
    while (fresh < newMiddle.length) {
      rows.push({ type: "+", text: newMiddle[fresh]!, newIndex: prefix + fresh });
      fresh += 1;
    }
  }

  for (let index = 0; index < suffix; index += 1) {
    const oldIndex = before.length - suffix + index;
    const newIndex = after.length - suffix + index;
    rows.push({ type: " ", text: before[oldIndex]!, oldIndex, newIndex });
  }

  return rows;
}

/** `start,count`, with the count omitted for a single line — unified style. */
function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** The old and new line numbers consumed before a row index. */
function consumedBefore(rows: DiffRow[], upto: number): { old: number; fresh: number } {
  let old = 0;
  let fresh = 0;
  for (let index = 0; index < upto; index += 1) {
    const row = rows[index]!;
    if (row.type !== "+") old += 1;
    if (row.type !== "-") fresh += 1;
  }
  return { old, fresh };
}

/** Groups changed rows, with their context, into `@@` hunks. */
function buildHunks(rows: DiffRow[], oldSide: SplitText, newSide: SplitText): string[] {
  const changed: number[] = [];
  rows.forEach((row, index) => {
    if (row.type !== " ") changed.push(index);
  });
  if (changed.length === 0) return [];

  const spans: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(rows.length - 1, index + CONTEXT_LINES);
    const last = spans[spans.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }

  const hunks: string[] = [];
  const lastOld = oldSide.lines.length - 1;
  const lastNew = newSide.lines.length - 1;

  for (const [start, end] of spans) {
    const body = rows.slice(start, end + 1);
    const oldCount = body.filter((row) => row.type !== "+").length;
    const newCount = body.filter((row) => row.type !== "-").length;
    const consumed = consumedBefore(rows, start);
    const firstOld = body.find((row) => row.oldIndex !== undefined)?.oldIndex;
    const firstNew = body.find((row) => row.newIndex !== undefined)?.newIndex;
    const oldStart = firstOld !== undefined ? firstOld + 1 : consumed.old;
    const newStart = firstNew !== undefined ? firstNew + 1 : consumed.fresh;

    const lines: string[] = [`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`];
    for (const row of body) {
      lines.push(`${row.type}${row.text}`);
      if (row.type !== "+" && row.oldIndex === lastOld && !oldSide.finalNewline) lines.push(NO_NEWLINE);
      if (row.type !== "-" && row.newIndex === lastNew && !newSide.finalNewline) lines.push(NO_NEWLINE);
    }
    hunks.push(lines.join("\n"));
  }

  return hunks;
}

/**
 * The hunks of a change, with line counts.
 *
 * An identical pair of strings is not a change: the result is empty and the
 * counts are zero, which is what makes a "no-op" refusal possible upstream.
 */
export function diffLines(before: string, after: string): { diff: string; added: number; removed: number } {
  if (before === after) return { diff: "", added: 0, removed: 0 };
  const oldSide = splitLines(before);
  const newSide = splitLines(after);
  const rows = diffRows(oldSide.lines, newSide.lines);
  return {
    diff: buildHunks(rows, oldSide, newSide).join("\n"),
    added: rows.filter((row) => row.type === "+").length,
    removed: rows.filter((row) => row.type === "-").length,
  };
}

/** A complete unified diff, including the file headers a reviewer expects. */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  kind: ChangeKind = "modified"
): string {
  if (before === after) return "";
  const { diff } = diffLines(before, after);
  if (!diff) return "";
  return [kind === "created" ? "--- /dev/null" : `--- a/${path}`, `+++ b/${path}`, diff].join("\n");
}

// ── Applying an edit ────────────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function tooLarge(text: string): string | null {
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > MAX_EDIT_BYTES
    ? `The result would be ${Math.round(bytes / 1024)} KB; this tool stages at most ${Math.round(
        MAX_EDIT_BYTES / 1024
      )} KB per file.`
    : null;
}

/**
 * Applies one edit to one file's text.
 *
 * `base` is null when the path does not exist at the base commit: that is a
 * creation, and only a whole-file `content` may create a file. Every refusal
 * carries a sentence the model can act on, because a thrown error would end the
 * turn instead of correcting the call.
 */
export function applyEdit(
  base: string | null,
  edit: Record<string, unknown>
): { ok: true; text: string } | { ok: false; reason: string } {
  const hasContent = typeof edit.content === "string";
  const hasOld = typeof edit.old_string === "string";
  const hasNew = typeof edit.new_string === "string";

  if (hasContent && (hasOld || hasNew)) {
    return { ok: false, reason: "Use either content (whole file) or old_string/new_string, not both in one edit." };
  }
  if (!hasContent && !hasOld) {
    return { ok: false, reason: "An edit needs content, or old_string together with new_string." };
  }
  if (hasOld && !hasNew) {
    return { ok: false, reason: "old_string needs new_string; pass an empty string to delete the matched text." };
  }
  if (hasNew && !hasOld) {
    return { ok: false, reason: "new_string needs old_string; a replacement must say what it replaces." };
  }

  if (hasContent) {
    const content = edit.content as string;
    if (base === null && !content.length) {
      return { ok: false, reason: "A new file needs content." };
    }
    if (base !== null && content === base) {
      return { ok: false, reason: "That content is identical to the file, so there is nothing to change." };
    }
    const size = tooLarge(content);
    if (size) return { ok: false, reason: size };
    return { ok: true, text: content };
  }

  const oldString = edit.old_string as string;
  const newString = edit.new_string as string;
  if (!oldString) {
    return { ok: false, reason: "old_string must not be empty; it has to match exactly once." };
  }
  if (base === null) {
    return {
      ok: false,
      reason: "There is no file at that path at this commit, so there is nothing to replace. Use content to create it.",
    };
  }

  const matches = countOccurrences(base, oldString);
  if (matches === 0) {
    return {
      ok: false,
      reason: "old_string does not appear in the file. Read it and copy the text exactly, or use content for a whole-file replacement.",
    };
  }
  if (matches > 1) {
    return {
      ok: false,
      reason: `old_string appears ${matches} times. Include more surrounding lines so it matches exactly once.`,
    };
  }

  const text = base.replace(oldString, newString);
  if (text === base) {
    return { ok: false, reason: "That replacement leaves the file unchanged." };
  }
  const size = tooLarge(text);
  if (size) return { ok: false, reason: size };
  return { ok: true, text };
}

// ── Staging a call ──────────────────────────────────────────────────────────

function pathOf(entry: Record<string, unknown>): string {
  return typeof entry.path === "string" ? entry.path : "";
}

/**
 * Validates and stages the edits from one `propose_edits` call.
 *
 * Several edits may name the same file: they are applied in order on top of one
 * another, and the caller receives a single change per path, diffed against the
 * base commit. That way a reviewer sees one file once, not a history of the
 * agent's own retries.
 */
export async function stageEdits(raw: unknown, context: EditContext): Promise<StagedSet> {
  const rejected: EditRejection[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { changes: [], rejected: [{ path: "", reason: "propose_edits needs a non-empty edits array." }] };
  }

  const entries = raw.slice(0, MAX_EDITS_PER_CALL);
  if (raw.length > MAX_EDITS_PER_CALL) {
    rejected.push({
      path: "",
      reason: `Only the first ${MAX_EDITS_PER_CALL} edits were staged. Propose the rest in another call.`,
    });
  }

  /** Text at the base commit. Null means the path does not exist there. */
  const original = new Map<string, string | null>();
  /** Text after the edits applied so far. */
  const working = new Map<string, string>();
  const order: string[] = [];
  const touched = new Set<string>();

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      rejected.push({ path: "", reason: "Each edit must be an object with a path." });
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const path = pathOf(entry);

    if (!path || path !== path.trim()) {
      rejected.push({ path, reason: "An edit needs a repository-relative path." });
      continue;
    }
    if (!isSafeRelativePath(path)) {
      rejected.push({ path, reason: "That path is not a relative path inside the repository." });
      continue;
    }
    if (isIgnoredPath(path)) {
      rejected.push({
        path,
        reason: "That path is build output, a lockfile or a dependency, so it is not part of the source this agent proposes changes to.",
      });
      continue;
    }

    if (!original.has(path)) {
      if (context.exists(path)) {
        const base = await context.readBase(path).catch(() => null);
        if (!base) {
          rejected.push({ path, reason: "That file could not be read as text, so it cannot be edited safely." });
          continue;
        }
        if (base.truncated) {
          rejected.push({ path, reason: "That file is larger than the read cap, so a diff against it would be incomplete." });
          continue;
        }
        original.set(path, base.text);
        working.set(path, base.text);
      } else {
        original.set(path, null);
        working.set(path, "");
      }
      order.push(path);
    }

    // Compose on the text staged so far, not on the base commit, or a second
    // edit to the same file would quietly discard the first.
    const before = original.get(path) ?? null;
    const current = before === null && !touched.has(path) ? null : working.get(path) ?? "";
    const applied = applyEdit(current, entry);
    if (!applied.ok) {
      rejected.push({ path, reason: applied.reason });
      continue;
    }
    working.set(path, applied.text);
    touched.add(path);
  }

  const changes: StagedChange[] = [];
  for (const path of order) {
    if (!touched.has(path)) continue;
    const before = original.get(path) ?? null;
    const after = working.get(path) ?? "";
    const beforeText = before ?? "";
    const kind: ChangeKind = before === null ? "created" : "modified";
    const { diff, added, removed } = diffLines(beforeText, after);
    if (!diff) {
      rejected.push({ path, reason: "The edits leave this file unchanged, so there is nothing to review." });
      continue;
    }
    if (diff.length > MAX_DIFF_CHARS) {
      rejected.push({ path, reason: "The diff for this file is too large to review. Split the change into smaller edits." });
      continue;
    }
    changes.push({
      path,
      kind,
      added,
      removed,
      diff: unifiedDiff(path, beforeText, after, kind),
      after,
      bytes: Buffer.byteLength(after, "utf8"),
    });
  }

  return { changes, rejected };
}
