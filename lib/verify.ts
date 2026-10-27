// ── What is checked before a change is handed over ───────────────────────────
//
// Two things are true about this module, and the first one is a limitation that
// is stated rather than hidden:
//
//   1. It does not run anything. There is no install, no build and no test
//      runner here — see the bottom of this comment for why, and what would be
//      needed to add one. Saying "verified" about a check that only read the
//      bytes would be the worst kind of lie in a product whose promise is that
//      nothing reaches a branch unchecked.
//   2. What it does check, it checks exactly. Every finding below is a fact
//      about the bytes that are about to be committed, or about the repository
//      they would be committed into. Nothing here guesses, because a false
//      finding blocks a real change.
//
// Two severities, and the difference is the whole design:
//
//   error   the change cannot be right on its own terms. No repository and no
//           environment makes invalid JSON valid, makes an empty source file
//           complete, or makes an import that resolves to nothing resolve.
//           A direct push is refused while one of these stands.
//   warning something is probably wrong, but the check could not be sure — an
//           import that may live outside the part of the tree we could read.
//           Warnings are shown and never block: the person is the reviewer.
//
// Pure, and that on purpose: no token, no network, no environment. It is what
// makes every rule below testable without a fake for the world.
//
// ── Why there is no build here ──────────────────────────────────────────────
// Running the change would mean installing its dependencies and building it
// somewhere other than this request: a serverless route cannot do it, and
// Openmi holds no execution sandbox. That is a real feature with a real cost,
// not a missing branch of this file. The static checks are the part that needs
// no new service, and they are honestly labelled as static in every report.

import { isIgnoredPath, isSafeRelativePath } from "./github/tree";

export type FindingSeverity = "error" | "warning";

export interface Finding {
  code: string;
  severity: FindingSeverity;
  path?: string;
  /** A clause, lowercase, without the path: the reader adds the path. */
  message: string;
}

export interface VerificationReport {
  ok: boolean;
  errors: Finding[];
  warnings: Finding[];
  /** What the check could not do, and why. Never empty in practice. */
  notes: string[];
}

export interface VerifiableFile {
  path: string;
  kind: "modified" | "created";
  after: string;
}

/** Extensions whose relative imports are resolved. */
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];
/** Extensions where an empty result is a mistake rather than a decision. */
const CODE_EXTENSIONS = [...MODULE_EXTENSIONS, ".py", ".rb", ".go", ".rs", ".java", ".php", ".css", ".scss", ".html"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"];

/** `from "x"`, `require("x")`, `import("x")`, `import "x"`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\(\s*|\brequire\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;

function extensionOf(filePath: string): string {
  const file = filePath.split("/").pop() ?? filePath;
  const dot = file.lastIndexOf(".");
  return dot <= 0 ? "" : file.slice(dot).toLowerCase();
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.includes(extensionOf(filePath));
}

/**
 * Files where comments and a trailing comma are expected rather than broken.
 *
 * TypeScript's own documentation writes `tsconfig.json` with comments, and
 * editors write `.jsonc` that way, so those two are read leniently. Everything
 * else is read as JSON, because that is what will read it at runtime.
 */
function allowsJsonc(filePath: string): boolean {
  const file = filePath.split("/").pop() ?? filePath;
  return file.endsWith(".jsonc") || file === "jsconfig.json" || /^tsconfig(\..*)?\.json$/.test(file);
}

/**
 * True when a `.json` file parses.
 *
 * The first attempt is strict, because that is what a program loading the file
 * will do. The lenient second attempt, which tolerates comments and a trailing
 * comma, is only made for the files in `allowsJsonc`: a trailing comma in
 * `package.json` is a real error that npm and bun both refuse, and accepting it
 * there would hide exactly the mistake this check exists to find.
 */
function parsesAsJson(filePath: string, text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    // Fall through to the lenient attempt, for JSONC files only.
    if (!allowsJsonc(filePath)) return false;
  }
  const stripped = text
    // Block comments, then line comments whose `//` is not inside a string
    // (a preceding `:` means a URL, which is the case that matters).
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    JSON.parse(stripped);
    return true;
  } catch {
    return false;
  }
}

/** Every relative specifier a module mentions. Aliases are not resolved. */
export function relativeSpecifiersIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? "";
    if (specifier.startsWith("./") || specifier.startsWith("../")) found.add(specifier);
  }
  return [...found];
}

/** The path a relative specifier points at, or null when it leaves the repo. */
function resolveSpecifier(fromPath: string, specifier: string): string | null {
  const out: string[] = [];
  for (const part of [...fromPath.split("/").slice(0, -1), ...specifier.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/**
 * The paths a specifier could legitimately mean.
 *
 * Bundlers and TypeScript resolve a bare name by trying extensions and then
 * `index` files, and TypeScript source often imports the *compiled* name — so
 * `./db.js` has to be allowed to mean `./db.ts`. Missing one of these would
 * turn a correct change into a refused one.
 */
function candidatesFor(target: string): string[] {
  const extension = extensionOf(target);
  const list = [target];
  if (extension === "") {
    for (const suffix of MODULE_EXTENSIONS) list.push(`${target}${suffix}`);
    for (const index of INDEX_FILES) list.push(`${target}/${index}`);
  } else if (extension === ".js" || extension === ".jsx" || extension === ".mjs") {
    const stem = target.slice(0, target.length - extension.length);
    list.push(`${stem}.ts`, `${stem}.tsx`);
    for (const index of INDEX_FILES) list.push(`${target}/${index}`);
  }
  return list;
}

/**
 * Checks a staged change against the repository it is about to be committed to.
 *
 * `treePaths` is every blob at the base commit, or null when it could not be
 * read. `treeComplete` is false when that list is truncated, and it is the
 * difference between an unresolved import being an error and being a warning:
 * the first is a fact, the second is a fact about a list we know is partial.
 */
export function verifyStagedFiles(input: {
  files: VerifiableFile[];
  treePaths?: readonly string[] | null;
  treeComplete?: boolean;
}): VerificationReport {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const treeKnown = Array.isArray(input.treePaths);
  const inTree = new Set<string>(input.treePaths ?? []);

  const known = new Set<string>(inTree);
  for (const file of input.files) known.add(file.path);

  if (input.files.length === 0) {
    errors.push({ code: "nothing", severity: "error", message: "there is nothing to check" });
  }

  for (const file of input.files) {
    // ── Where the file is ────────────────────────────────────────────────────
    if (!isSafeRelativePath(file.path)) {
      errors.push({
        code: "path-unsafe",
        severity: "error",
        path: file.path,
        message: "it is not a path inside the repository, so it cannot be committed",
      });
      continue;
    }
    if (isIgnoredPath(file.path)) {
      errors.push({
        code: "path-ignored",
        severity: "error",
        path: file.path,
        message: "it is build output or a lockfile, which Openmi does not commit",
      });
      continue;
    }

    // ── The bytes ────────────────────────────────────────────────────────────
    if (file.after.includes("\u0000")) {
      errors.push({
        code: "binary",
        severity: "error",
        path: file.path,
        message: "it contains binary data, which a text diff cannot commit correctly",
      });
      continue;
    }

    const extension = extensionOf(file.path);
    if ((extension === ".json" || extension === ".jsonc") && !parsesAsJson(file.path, file.after)) {
      errors.push({
        code: "bad-json",
        severity: "error",
        path: file.path,
        message: "it is not valid JSON, so the change would break everything that reads it",
      });
    }

    if (isCodeFile(file.path) && file.after.trim().length === 0) {
      errors.push({
        code: "empty-file",
        severity: "error",
        path: file.path,
        message: "it is empty, which for a source file is almost always a generation that failed",
      });
    }

    if (file.kind === "created" && inTree.has(file.path)) {
      errors.push({
        code: "new-file-exists",
        severity: "error",
        path: file.path,
        message: "it already exists at this commit, so this is an edit pretending to be a new file",
      });
    }

    // ── What it points at ────────────────────────────────────────────────────
    if (!isCodeFile(file.path)) continue;
    for (const specifier of relativeSpecifiersIn(file.after)) {
      const target = resolveSpecifier(file.path, specifier);
      if (!target) {
        warnings.push({
          code: "import-outside",
          severity: "warning",
          path: file.path,
          message: `it imports "${specifier}", which points outside the repository`,
        });
        continue;
      }
      if (candidatesFor(target).some((candidate) => known.has(candidate))) continue;
      const finding: Finding = {
        code: "missing-import",
        severity: treeCompleteFor(input) ? "error" : "warning",
        path: file.path,
        message: `it imports "${specifier}", and nothing at ${target} exists in the repository`,
      };
      if (finding.severity === "error") errors.push(finding);
      else warnings.push(finding);
    }
  }

  const notes: string[] = [];
  if (!treeKnown) {
    notes.push("The repository tree could not be read, so no import was resolved against it.");
  } else if (input.treeComplete !== true) {
    notes.push(
      "The repository tree was truncated, so an import that resolves to nothing is reported as a warning rather than an error."
    );
  }
  notes.push(
    "These checks are static: they read the bytes. Nothing is installed, built or run, so a change that passes here can still fail in CI."
  );

  return { ok: errors.length === 0, errors, warnings, notes };
}

function treeCompleteFor(input: { treeComplete?: boolean }): boolean {
  return input.treeComplete === true;
}

/** One line per finding, path first, for a notice or an API error body. */
export function summarizeFindings(findings: readonly Finding[]): string[] {
  return findings.map((finding) => (finding.path ? `${finding.path}: ${finding.message}` : finding.message));
}

/** One sentence for the reader, from a report. */
export function describeReport(report: VerificationReport): string {
  if (report.errors.length > 0) {
    return `The change failed its own checks: ${summarizeFindings(report.errors).join("; ")}.`;
  }
  if (report.warnings.length > 0) {
    return `The change passed its checks with notes: ${summarizeFindings(report.warnings).join("; ")}.`;
  }
  return "The change passed its checks.";
}
