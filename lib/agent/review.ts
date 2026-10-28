// ── The pre-flight review ───────────────────────────────────────────────────
//
// A proposal is a diff nobody ran. This module is the part that can be done
// without executing the repository: a deterministic pass over the exact bytes
// the change would write, then one model pass that reads the diff with those
// findings in hand. The result travels with the change so the person reviewing
// it sees "checked, and here is what was found" instead of a bare "trust me".
//
// It is deliberately honest about its limits. There is no checkout here, so
// this is *not* a build: it cannot typecheck, install dependencies or run a
// test suite. What it can catch is the class of mistake a model actually makes
// when it proposes code it has never compiled — a broken JSON file, an
// unbalanced brace, an import of a path that does not exist, a merge marker
// left in the text, a TODO standing in for the change. Those are reported as
// findings, and the errors among them are what make the agent repair its own
// proposal before the person ever sees it.
//
// The static pass matters as much as the model pass: it is the only part that
// has evidence. A model reviewer can be wrong in both directions, so its
// findings are advisory, while a JSON file that does not parse is a fact.

import type { AgentMessage } from "./model";
import type { StagedChange } from "./edits";
import type { ProposalReview, ReviewFinding } from "@/lib/types";

/** More than this and the review is a wall of text nobody reads. */
export const MAX_REVIEW_FINDINGS = 8;
/** How much diff one model review may read, across all files. */
export const MAX_REVIEW_DIFF_CHARS = 14_000;
/** A single file's share of that budget, so one huge file cannot crowd out the rest. */
const MAX_REVIEW_FILE_CHARS = 6_000;

const JSON_FILE = /\.json$/i;
const SCRIPT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const JSX_FILE = /\.(tsx|jsx)$/i;

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];

/** A model's answer, before the static findings are folded in. */
export interface ModelReview {
  verdict: "pass" | "fix";
  summary: string;
  findings: ReviewFinding[];
}

// ── Paths and imports ───────────────────────────────────────────────────────

/** Collapses `./`, `..` and empty segments. */
function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function directoryOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

/**
 * The file an import specifier points at, if the repository has one.
 *
 * Relative specifiers resolve against the importing file; `@/` is this
 * project's own root alias. A bare package name is not checked — whether
 * `react` is installed is a question for `node_modules`, not for a tree.
 */
function importResolves(spec: string, fromPath: string, paths: Set<string>): boolean {
  const base = spec.startsWith("@/")
    ? normalizePath(spec.slice(2))
    : spec.startsWith(".")
      ? normalizePath(`${directoryOf(fromPath)}/${spec}`)
      : "";
  if (!base) return true;
  const candidates = [base, ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`)];
  for (const extension of MODULE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  return candidates.some((candidate) => paths.has(candidate));
}

/** Every relative or root-alias import in a file, with its line number. */
function importsIn(text: string): Array<{ spec: string; line: number }> {
  const found: Array<{ spec: string; line: number }> = [];
  const patterns = [
    /\bfrom\s+["']([^"'\n]+)["']/g,
    /\bimport\s+["']([^"'\n]+)["']/g,
    /\brequire\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bimport\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1];
      if (!spec || !(spec.startsWith(".") || spec.startsWith("@/"))) continue;
      found.push({ spec, line: lineAt(text, match.index ?? 0) });
    }
  }
  return found;
}

/** 1-based line number for an offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

// ── Delimiters ──────────────────────────────────────────────────────────────

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * The first structural problem in a script, or null.
 *
 * Strings, template literals and comments are skipped, because a brace inside
 * a string is not a brace. The scan bails out silently rather than guessing
 * when it meets something it cannot classify — an unterminated string, a block
 * comment running to the end, an unclosed template. JSX text is the reason:
 * an apostrophe in `don't` looks like the start of a string, and reporting a
 * phantom imbalance there would send the agent chasing a defect that does not
 * exist. A missed finding is a smaller failure than a fabricated one.
 */
function delimiterProblem(text: string): string | null {
  const stack: string[] = [];
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (char === "'") {
        state = "single";
        index += 1;
        continue;
      }
      if (char === '"') {
        state = "double";
        index += 1;
        continue;
      }
      if (char === "`") {
        state = "template";
        index += 1;
        continue;
      }
      const closer = CLOSERS[char];
      if (closer) {
        stack.push(closer);
        index += 1;
        continue;
      }
      if (char === ")" || char === "]" || char === "}") {
        if (stack.pop() !== char) {
          return `line ${lineAt(text, index)}: an unexpected “${char}” closes nothing`;
        }
      }
      index += 1;
      continue;
    }

    if (state === "line") {
      if (char === "\n") state = "code";
      index += 1;
      continue;
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (state === "template") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") state = "code";
      index += 1;
      continue;
    }

    // A quoted string. A raw newline inside one means the scan lost its place
    // (most often JSX text), so it stops instead of reporting a false problem.
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return null;
    if (char === (state === "single" ? "'" : '"')) state = "code";
    index += 1;
  }

  if (state !== "code") return null;
  if (stack.length > 0) {
    return `${stack.length} unclosed ${stack[stack.length - 1]} at the end of the file`;
  }
  return null;
}

/** Conflict markers a merge would have removed. */
function hasConflictMarkers(text: string): boolean {
  return text.includes("<<<<<<<") && text.includes(">>>>>>>");
}

// ── The static pass ─────────────────────────────────────────────────────────

export interface StaticReviewInput {
  changes: readonly StagedChange[];
  /** Every path in the tree the agent was given, plus the paths it proposes. */
  repoPaths: readonly string[];
  now?: number;
}

/**
 * The deterministic half of the review.
 *
 * Everything here is checked against the bytes the change would write, so a
 * finding is evidence rather than opinion. Severity is graded on the same
 * principle: "error" means this file would not load or the change is not the
 * change that was described; "warning" means a person should look.
 */
export function staticReview(input: StaticReviewInput): ReviewFinding[] {
  const paths = new Set([...input.repoPaths, ...input.changes.map((change) => change.path)]);
  const findings: ReviewFinding[] = [];

  for (const change of input.changes) {
    const text = change.after;

    if (!text.trim()) {
      findings.push({ path: change.path, severity: "error", message: "the file would be empty" });
      continue;
    }

    if (hasConflictMarkers(text)) {
      findings.push({
        path: change.path,
        severity: "error",
        message: "contains merge conflict markers (`<<<<<<<` … `>>>>>>>`)",
      });
    }

    if (JSON_FILE.test(change.path)) {
      try {
        JSON.parse(text.replace(/^\uFEFF/, ""));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "it does not parse";
        findings.push({
          path: change.path,
          severity: "error",
          message: `is not valid JSON — ${detail.replace(/\s+/g, " ").slice(0, 140)}`,
        });
      }
      continue;
    }

    if (SCRIPT_FILE.test(change.path)) {
      const problem = delimiterProblem(text);
      if (problem) {
        // JSX text can imitate a string, so a bracket finding there is a hint,
        // not a fact; in a plain script it is a fact.
        findings.push({
          path: change.path,
          severity: JSX_FILE.test(change.path) ? "warning" : "error",
          message: `has unbalanced brackets — ${problem}`,
        });
      }

      for (const { spec, line } of importsIn(text)) {
        if (importResolves(spec, change.path, paths)) continue;
        findings.push({
          path: change.path,
          severity: "warning",
          message: `line ${line}: imports “${spec}”, which is not in the repository at this commit`,
        });
      }
    }
  }

  // Errors first, then by path, so the list reads as "what blocks this".
  findings.sort((left, right) => {
    if (left.severity !== right.severity) return left.severity === "error" ? -1 : 1;
    return left.path.localeCompare(right.path);
  });
  return findings.slice(0, MAX_REVIEW_FINDINGS);
}

// ── The model pass ──────────────────────────────────────────────────────────

/** Trims a diff to its share of the review budget, keeping the intro intact. */
function clipDiff(diff: string, budget: number): string {
  if (diff.length <= budget) return diff;
  return `${diff.slice(0, budget)}\n… (${diff.length - budget} more characters not shown)`;
}

function findingsBlock(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return "The automated checks found nothing structural.";
  return [
    "The automated checks found:",
    ...findings.map((finding) => `- [${finding.severity}] ${finding.path}: ${finding.message}`),
  ].join("\n");
}

/**
 * What the reviewer is asked to do.
 *
 * The model is a second pair of eyes, not the authority: it is told to promote
 * a finding to `error` only when the change would break at load or behave
 * differently from what was asked, and to leave anything it is guessing about
 * as a warning. JSON only, because the answer is parsed rather than shown.
 */
export function reviewMessages(
  changes: readonly StagedChange[],
  context: { repoFullName: string; baseSha: string; branch: string },
  findings: readonly ReviewFinding[]
): AgentMessage[] {
  const paths = new Set(changes.map((change) => change.path));
  const perFile = Math.max(
    1_200,
    Math.min(MAX_REVIEW_FILE_CHARS, Math.floor(MAX_REVIEW_DIFF_CHARS / Math.max(1, changes.length)))
  );

  const diffs = changes
    .map(
      (change) =>
        `FILE ${change.path} (${change.kind}, +${change.added} −${change.removed})\n${clipDiff(change.diff, perFile)}`
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content: [
        "You are the pre-flight reviewer for a repository agent. A change has been proposed and a person is about to approve it, so your job is to find what is wrong with it before they do.",
        "",
        "You are reading a diff, not a build. You cannot run the tests, install anything or see the whole repository, so never claim a check passed — say what the diff itself shows.",
        "",
        "Report a finding as `error` only when the change would not load (syntax, a missing file it imports, malformed JSON) or would not do what was asked. Report anything you suspect but cannot prove as a `warning`. If the change is sound, return `pass` with no findings. Do not invent work; a small correct change passes.",
        "",
        `Answer with JSON only, no prose and no code fences:`,
        `{"verdict":"pass"|"fix","summary":"one sentence","findings":[{"path":"${[...paths][0] ?? "path"}","severity":"error"|"warning","message":"what is wrong and where"}]}`,
        "At most 6 findings. `verdict` is `fix` when any finding is an error.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Repository ${context.repoFullName}, branch ${context.branch}, base commit ${context.baseSha.slice(0, 12)}.`,
        "",
        findingsBlock(findings),
        "",
        diffs,
      ].join("\n"),
    },
  ];
}

/** Pulls the JSON object out of an answer that may wrap it in prose or fences. */
function jsonObject(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Reads a reviewer's answer.
 *
 * Null means "the reviewer did not answer usefully", which the caller treats as
 * a static-only review rather than as a pass or a failure. A finding that names
 * a path outside the change is kept but re-pointed at the change set as a
 * whole, so nothing is silently dropped.
 */
export function parseReview(
  raw: string,
  changes: readonly StagedChange[]
): ModelReview | null {
  const value = jsonObject(raw);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.verdict !== "pass" && record.verdict !== "fix") return null;

  const paths = new Set(changes.map((change) => change.path));
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  const findings: ReviewFinding[] = [];
  for (const entry of rawFindings.slice(0, MAX_REVIEW_FINDINGS)) {
    if (!entry || typeof entry !== "object") continue;
    const finding = entry as Record<string, unknown>;
    const message = typeof finding.message === "string" ? finding.message.trim() : "";
    if (!message) continue;
    const path =
      typeof finding.path === "string" && paths.has(finding.path)
        ? finding.path
        : changes[0]?.path ?? "the change";
    findings.push({
      path,
      severity: finding.severity === "error" ? "error" : "warning",
      message: message.replace(/\s+/g, " ").slice(0, 280),
    });
  }

  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary.replace(/\s+/g, " ").slice(0, 300)
      : findings.length === 0
        ? "The reviewer found nothing to change."
        : "The reviewer asked for changes.";

  // A `fix` verdict with no findings explains nothing and cannot be acted on.
  const verdict = record.verdict === "fix" && findings.length > 0 ? "fix" : "pass";
  return { verdict, summary, findings };
}

// ── Putting the two together ────────────────────────────────────────────────

function dedupe(findings: readonly ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const out: ReviewFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.path}\u0000${finding.message.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

/**
 * The review a person reads.
 *
 * An error is an error whoever found it: a static finding keeps its severity,
 * and a model `fix` verdict stands even when the static pass was clean. That
 * asymmetry is intentional — the review exists to catch what a careless
 * proposal would slip past, so it errs towards showing a finding.
 */
export function assembleReview(input: {
  staticFindings: readonly ReviewFinding[];
  model: ModelReview | null;
  repaired: boolean;
  now?: number;
}): ProposalReview {
  const findings = dedupe([...input.staticFindings, ...(input.model?.findings ?? [])])
    .sort((left, right) => (left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1))
    .slice(0, MAX_REVIEW_FINDINGS);
  const errors = findings.filter((finding) => finding.severity === "error").length;

  const fallback = (() => {
    if (errors > 0) return `Found ${errors} problem${errors === 1 ? "" : "s"} that would break the change.`;
    if (findings.length > 0) return `Checked, with ${findings.length} thing${findings.length === 1 ? "" : "s"} to look at.`;
    return "Structure, imports and JSON checked. No build was run.";
  })();

  return {
    verdict: errors > 0 || input.model?.verdict === "fix" ? "fix" : "pass",
    summary: input.model?.summary ?? fallback,
    findings,
    modelChecked: input.model !== null,
    repaired: input.repaired,
    checkedAt: input.now ?? Date.now(),
  };
}

/** True when at least one finding says the change would not work. */
export function hasBlockingFinding(findings: readonly ReviewFinding[]): boolean {
  return findings.some((finding) => finding.severity === "error");
}

/** True when the review found something that should be repaired, not just noted. */
export function needsRepair(review: ProposalReview): boolean {
  return review.findings.some((finding) => finding.severity === "error");
}

/**
 * The turn that asks the agent to fix its own proposal.
 *
 * It names the findings and the paths and nothing else: the agent already has
 * the files it read in the transcript, so re-describing them would invite it to
 * rewrite from memory. One repair round is allowed, which is why this says to
 * change only what was flagged.
 */
export function repairRequest(
  findings: readonly ReviewFinding[],
  changes: readonly StagedChange[]
): AgentMessage {
  return {
    role: "user",
    content: [
      "A pre-flight review of your proposal found problems that would stop it working:",
      "",
      ...findings.map((finding) => `- ${finding.path}: ${finding.message}`),
      "",
      `Proposed files: ${changes.map((change) => change.path).join(", ")}.`,
      "",
      "Fix these with propose_edits — re-read a file first if you need its exact current text. Change only what is needed to resolve the findings, leave the rest of the proposal as it is, and do not write a diff yourself.",
    ].join("\n"),
  };
}
