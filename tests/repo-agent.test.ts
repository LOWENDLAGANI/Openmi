// ── Openmi — tests for the read-only repository agent ────────────────────────
//
// Phase 1 makes exactly one promise that matters: the agent can read a
// repository and cannot change it. Everything below is either a piece of that
// promise or a limit that keeps one turn from costing more than it was priced at.
//
//   bun run test
//
// Pure modules only, plus source-contract checks that fail if somebody adds a
// write to the GitHub client or a fourth tool. No network, no Firebase.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyFromEnv, seal, sign, unseal, verify } from "../lib/github/crypto";
import {
  MAX_TREE_PATHS,
  directoriesOf,
  filterTree,
  isSafeRelativePath,
  rankPaths,
  type TreeFile,
} from "../lib/github/tree";
import { formatHits, pickSearchCandidates, searchFiles } from "../lib/github/search";
import { clearRepoCache } from "../lib/github/cache";
import { runAgentStep } from "../lib/agent/run";
import { AGENT_TOOL_SCHEMAS, READ_ONLY_TOOLS, runTool, type ToolContext } from "../lib/agent/tools";
import {
  MAX_EDIT_BYTES,
  MAX_EDITS_PER_CALL,
  applyEdit,
  diffLines,
  stageEdits,
  unifiedDiff,
  type EditContext,
} from "../lib/agent/edits";
import {
  MAX_STEPS,
  MAX_TURN_TOKENS,
  advanceTurn,
  createTurn,
  readTurn,
  signTurn,
  turnExhausted,
} from "../lib/agent/turns";
import { isSameOriginRequest } from "../lib/serverControl";
import type { GithubTreeEntry } from "../lib/github/client";

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

// Tests that read a base file are asynchronous, and this file is compiled as
// CommonJS by tsx, so they cannot use top-level await. They are collected here
// and run by the runner at the end, in the order they were declared.
const deferred: Array<[string, () => Promise<void>]> = [];

function later(name: string, fn: () => Promise<void>): void {
  deferred.push([name, fn]);
}

async function atest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// A 32-byte key, fixed so a failure is reproducible.
const KEY = Buffer.from("9f".repeat(32), "hex");

// ── crypto ──────────────────────────────────────────────────────────────────
console.log("\ncrypto");

test("a sealed token opens with the same key", () => {
  const token = "gho_abcdefghijklmnopqrstuvwxyz0123";
  const sealed = seal(token, KEY);
  assert.ok(sealed.startsWith("v1."), "sealed values are versioned");
  assert.ok(!sealed.includes(token), "the plaintext must not appear in the blob");
  assert.equal(unseal(sealed, KEY), token);
});

test("sealing twice gives different ciphertexts", () => {
  const a = seal("same input", KEY);
  const b = seal("same input", KEY);
  assert.notEqual(a, b, "a reused IV would leak that two tokens are equal");
});

test("a sealed token does not open with another key", () => {
  const other = Buffer.from("11".repeat(32), "hex");
  assert.equal(unseal(seal("secret", KEY), other), null);
});

test("a tampered sealed token is refused", () => {
  const sealed = seal("gho_originaltokenvalue", KEY);
  const parts = sealed.split(".");
  const body = Buffer.from(parts[3]!, "base64url");
  body[body.length - 1] ^= 0xff;
  parts[3] = body.toString("base64url");
  assert.equal(unseal(parts.join("."), KEY), null);
});

test("a malformed sealed value is refused rather than thrown", () => {
  for (const value of ["", "v1", "v1.a.b", "v2.a.b.c", "v1...."]) {
    assert.equal(unseal(value, KEY), null, `expected null for ${JSON.stringify(value)}`);
  }
});

test("a signed payload verifies and round-trips", () => {
  const payload = { steps: 2, paid: true };
  assert.deepEqual(verify(sign(payload, KEY), KEY), payload);
});

test("an edited signed payload is refused", () => {
  const token = sign({ steps: 2 }, KEY);
  const body = Buffer.from(JSON.stringify({ steps: 0 }), "utf8").toString("base64url");
  assert.equal(verify(`${body}.${token.split(".").pop()}`, KEY), null);
});

test("a key from the environment must be exactly 32 bytes of hex", () => {
  assert.equal(keyFromEnv("ab".repeat(32))?.length, 32);
  assert.equal(keyFromEnv(""), null);
  assert.equal(keyFromEnv(undefined), null);
  assert.equal(keyFromEnv("ab".repeat(31)), null);
  assert.equal(keyFromEnv("zz".repeat(32)), null);
});

// ── paths and the tree ──────────────────────────────────────────────────────
console.log("\ntree");

test("safe paths are relative and inside the repository", () => {
  assert.equal(isSafeRelativePath("src/app/page.tsx"), true);
  assert.equal(isSafeRelativePath("README.md"), true);
});

test("every escape hatch is refused", () => {
  for (const path of [
    "../etc/passwd",
    "src/../../etc/passwd",
    "/etc/passwd",
    "src\\app.ts",
    "a//b",
    "./a",
    "a/./b",
    ".",
    "",
    "a\0b",
    null,
    undefined,
    42,
    "a".repeat(401),
  ]) {
    assert.equal(isSafeRelativePath(path as string), false, `expected refusal for ${String(path)}`);
  }
});

const entries: GithubTreeEntry[] = [
  { path: "src/app/page.tsx", type: "blob", sha: "a1", size: 1200 },
  { path: "src/lib/dew.ts", type: "blob", sha: "a2", size: 900 },
  { path: "src", type: "tree", sha: "a3" },
  { path: "README.md", type: "blob", sha: "a4", size: 300 },
  { path: "package-lock.json", type: "blob", sha: "a5", size: 900_000 },
  { path: "node_modules/react/index.js", type: "blob", sha: "a6", size: 400 },
  { path: "dist/bundle.min.js", type: "blob", sha: "a7", size: 400 },
  { path: "public/logo.svg", type: "blob", sha: "a8", size: 400 },
  { path: "docs/notes.md", type: "blob", sha: "a9", size: 400 },
];

test("only source files survive the filter", () => {
  const { files } = filterTree(entries);
  assert.deepEqual(
    files.map((file) => file.path),
    ["docs/notes.md", "README.md", "src/app/page.tsx", "src/lib/dew.ts"]
  );
});

test("the ignored set is not the whole repository", () => {
  const { total } = filterTree(entries);
  assert.equal(total, 8, "total counts all blobs, so truncation is explainable");
});

test("the cap counts kept files and says when it cut", () => {
  const { files, truncated } = filterTree(entries, false, 2);
  assert.equal(files.length, 2);
  assert.equal(truncated, true);
});

test("a complete list is not reported as truncated", () => {
  const { truncated } = filterTree(entries, false, MAX_TREE_PATHS);
  assert.equal(truncated, false);
});

test("GitHub's own truncation is carried through", () => {
  assert.equal(filterTree(entries, true).githubTruncated, true);
});

test("directories are implied by the file list", () => {
  const files = filterTree(entries).files;
  assert.deepEqual(directoriesOf(files), ["docs", "src", "src/app", "src/lib"]);
});

test("an exact file name outranks a path that merely contains the word", () => {
  const files = filterTree(entries).files;
  const ranked = rankPaths(files, "dew.ts");
  assert.equal(ranked[0]?.path, "src/lib/dew.ts");
});

test("a query with no match returns nothing rather than everything", () => {
  const files = filterTree(entries).files;
  assert.deepEqual(rankPaths(files, "kubernetes-operator"), []);
});

// ── search ──────────────────────────────────────────────────────────────────
console.log("\nsearch");

const searchable = [
  { path: "src/dew.ts", size: 200, text: "export const DEW = 0.5;\n// the price\nconst again = DEW;\nconst third = DEW;\nconst fourth = DEW;" },
  { path: "src/chat.ts", size: 200, text: "import { DEW } from './dew';\n" },
  { path: "huge/generated.ts", size: 999_999, text: "DEW DEW DEW" },
];

test("search is literal and case-insensitive", () => {
  const hits = searchFiles(searchable, "dew =");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.line, 1);
});

test("hits carry a 1-based line number", () => {
  const hits = searchFiles(searchable, "price");
  assert.equal(hits[0]?.line, 2);
});

test("one file cannot flood the results", () => {
  const hits = searchFiles(searchable, "dew");
  const fromDew = hits.filter((hit) => hit.path === "src/dew.ts");
  assert.ok(fromDew.length <= 3, `expected at most 3 hits per file, got ${fromDew.length}`);
});

test("files past the size cap are never opened", () => {
  const hits = searchFiles(searchable, "DEW DEW");
  assert.equal(hits.length, 0);
});

test("an empty query searches nothing", () => {
  assert.deepEqual(searchFiles(searchable, "   "), []);
});

test("candidates are path-relevant and capped", () => {
  const files: TreeFile[] = [
    { path: "src/dew.ts", sha: "1", size: 10 },
    { path: "src/chat.ts", sha: "2", size: 10 },
    { path: "src/unrelated.ts", sha: "3", size: 10 },
  ];
  assert.deepEqual(pickSearchCandidates(files, "dew").map((file) => file.path), ["src/dew.ts"]);
  assert.equal(pickSearchCandidates(files, "ts", 1).length, 1);
});

test("formatted hits read as path:line:text", () => {
  assert.equal(formatHits([{ path: "a.ts", line: 3, text: "hi" }]), "a.ts:3: hi");
  assert.equal(formatHits([]), "No matches.");
});

// ── tools ───────────────────────────────────────────────────────────────────
console.log("\ntools");

const files = filterTree(entries).files;

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    files,
    readFile: async (path) => (path === "src/lib/dew.ts" ? { text: "export const DEW = 0.5;", truncated: false } : null),
    search: async (query) =>
      query === "DEW" ? [{ path: "src/lib/dew.ts", line: 1, text: "export const DEW = 0.5;" }] : [],
    ...overrides,
  };
}

test("the agent can read and propose, and no tool can write", () => {
  assert.deepEqual([...READ_ONLY_TOOLS], ["list_files", "read_file", "search_code"]);
  assert.deepEqual(
    AGENT_TOOL_SCHEMAS.map((schema) => schema.function.name),
    ["list_files", "read_file", "search_code", "propose_edits"]
  );
  for (const forbidden of ["write_file", "commit", "delete_file", "run_command", "merge_pull_request", "create_pull_request"]) {
    assert.equal(
      AGENT_TOOL_SCHEMAS.some((schema) => schema.function.name === (forbidden as never)),
      false,
      `${forbidden} must not be a tool`
    );
  }
});

test("an invented tool is refused without touching the repository", async () => {
  let called = false;
  const result = await runTool(
    { id: "1", name: "write_file", argumentJson: '{"path":"a.ts"}' },
    context({
      readFile: async () => {
        called = true;
        return null;
      },
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /no tool named/i);
  assert.equal(called, false);
});

test("list_files narrows to a path and collapses deep paths", async () => {
  const result = await runTool({ id: "1", name: "list_files", argumentJson: '{"path":"src","depth":2}' }, context());
  assert.equal(result.ok, true);
  assert.match(result.content, /src\/lib\/…/);
  assert.doesNotMatch(result.content, /README/);
});

test("list_files refuses a traversal path", async () => {
  const result = await runTool(
    { id: "1", name: "list_files", argumentJson: '{"path":"../.."}' },
    context()
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /not a relative path/i);
});

test("read_file returns the text of a file that exists", async () => {
  const result = await runTool({ id: "1", name: "read_file", argumentJson: '{"path":"src/lib/dew.ts"}' }, context());
  assert.equal(result.ok, true);
  assert.match(result.content, /export const DEW/);
  assert.equal(result.summary.includes("src/lib/dew.ts"), true);
});

test("read_file for a missing file suggests the nearest paths", async () => {
  const result = await runTool({ id: "1", name: "read_file", argumentJson: '{"path":"src/lib/dew"}' }, context());
  assert.equal(result.ok, false);
  assert.match(result.content, /Closest paths/);
});

test("read_file refuses an absolute path", async () => {
  const result = await runTool({ id: "1", name: "read_file", argumentJson: '{"path":"/etc/passwd"}' }, context());
  assert.equal(result.ok, false);
});

test("read_file explains a binary file instead of returning bytes", async () => {
  const result = await runTool(
    { id: "1", name: "read_file", argumentJson: '{"path":"src/app/page.tsx"}' },
    context({ readFile: async () => null })
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /binary/i);
});

test("a file past the size cap is skipped rather than opened", async () => {
  const big: TreeFile[] = [{ path: "src/huge.ts", sha: "x", size: 500_000 }];
  let opened = false;
  const result = await runTool(
    { id: "1", name: "read_file", argumentJson: '{"path":"src/huge.ts"}' },
    context({
      files: big,
      readFile: async () => {
        opened = true;
        return { text: "", truncated: false };
      },
    })
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /too large/i);
  assert.equal(opened, false);
});

test("search_code returns formatted hits", async () => {
  const result = await runTool({ id: "1", name: "search_code", argumentJson: '{"query":"DEW"}' }, context());
  assert.equal(result.ok, true);
  assert.match(result.content, /src\/lib\/dew\.ts:1:/);
});

test("an empty search is refused before any file is opened", async () => {
  const result = await runTool({ id: "1", name: "search_code", argumentJson: '{"query":"  "}' }, context());
  assert.equal(result.ok, false);
});

test("broken argument JSON is treated as no arguments, not a crash", async () => {
  const result = await runTool({ id: "1", name: "search_code", argumentJson: "{not json" }, context());
  assert.equal(result.ok, false);
  assert.match(result.content, /needs a query/i);
});

// ── proposals and diffs ─────────────────────────────────────────────────────
console.log("\nedits");

const DEW_FILE = 'export const DEW = 0.5;\nexport const MODES = ["auto", "code"];\n';

function editContext(
  texts: Record<string, string> = { "src/lib/dew.ts": DEW_FILE },
  overrides: Partial<EditContext> = {}
): EditContext {
  return {
    exists: (path) => path in texts,
    readBase: async (path) => (path in texts ? { text: texts[path]!, truncated: false } : null),
    ...overrides,
  };
}

test("a diff names the file and counts what changed", () => {
  const before = "one\ntwo\nthree\n";
  const after = "one\nTWO\nthree\n";
  const { diff, added, removed } = diffLines(before, after);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.match(diff, /^@@ -1,3 \+1,3 @@$/m);
  assert.match(diff, /^-two$/m);
  assert.match(diff, /^\+TWO$/m);
  assert.match(diff, /^ one$/m);
  assert.equal(unifiedDiff("src/a.ts", before, after), `--- a/src/a.ts\n+++ b/src/a.ts\n${diff}`);
});

test("an unchanged file has no diff at all", () => {
  assert.deepEqual(diffLines(DEW_FILE, DEW_FILE), { diff: "", added: 0, removed: 0 });
  assert.equal(unifiedDiff("src/a.ts", DEW_FILE, DEW_FILE), "");
});

test("a small edit is shown with three lines of context, not the whole file", () => {
  const before = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const after = before.replace("line 5", "line five");
  const { diff } = diffLines(before, after);
  assert.match(diff, /^@@ -2,7 \+2,7 @@$/m);
  assert.match(diff, /^ line 2$/m);
  assert.doesNotMatch(diff, /^ line 1$/m);
});

test("a file without a trailing newline is marked, as diff tooling expects", () => {
  const { diff } = diffLines("a\nb", "a\nc");
  assert.equal(diff.split("\\ No newline at end of file").length - 1, 2);
});

test("a new file is diffed against /dev/null", () => {
  const diff = unifiedDiff("src/new.ts", "", "hello\n", "created");
  assert.match(diff, /^--- \/dev\/null$/m);
  assert.match(diff, /^\+\+\+ b\/src\/new\.ts$/m);
  assert.match(diff, /^@@ -0,0 \+1 @@$/m);
});

test("a whole-file replacement applies and an identical one does not", () => {
  const replaced = applyEdit(DEW_FILE, { path: "src/lib/dew.ts", content: "export const DEW = 0.25;\n" });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.ok ? replaced.text : "", "export const DEW = 0.25;\n");

  const identical = applyEdit(DEW_FILE, { path: "src/lib/dew.ts", content: DEW_FILE });
  assert.equal(identical.ok, false);
  assert.match(identical.ok ? "" : identical.reason, /nothing to change/i);
});

test("a unique old_string is replaced; an ambiguous one is refused", () => {
  const replaced = applyEdit(DEW_FILE, { old_string: "0.5", new_string: "0.25" });
  assert.equal(replaced.ok, true);
  assert.match(replaced.ok ? replaced.text : "", /DEW = 0\.25/);

  const ambiguous = applyEdit("a\na\n", { old_string: "a", new_string: "b" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.reason, /appears 2 times/);
});

test("a missing old_string is refused rather than appended", () => {
  const result = applyEdit(DEW_FILE, { old_string: "not in the file", new_string: "x" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /does not appear/);
});

test("an edit is one shape or the other, never both", () => {
  const mixed = applyEdit(DEW_FILE, { content: "x\n", old_string: "0.5", new_string: "x" });
  assert.equal(mixed.ok, false);
  assert.match(mixed.ok ? "" : mixed.reason, /not both/);

  const empty = applyEdit(DEW_FILE, { old_string: "", new_string: "x" });
  assert.equal(empty.ok, false);
});

test("a new file needs content and a file past the cap is refused", () => {
  assert.equal(applyEdit(null, { path: "src/new.ts", content: "" }).ok, false);
  const big = applyEdit(null, { path: "src/big.ts", content: "x".repeat(MAX_EDIT_BYTES + 1) });
  assert.equal(big.ok, false);
  assert.match(big.ok ? "" : big.reason, /at most/);
});

later("a whole-file change is staged with a server-computed diff", async () => {
  const staged = await stageEdits(
    [{ path: "src/lib/dew.ts", content: DEW_FILE.replace("0.5", "0.25") }],
    editContext()
  );
  assert.equal(staged.rejected.length, 0);
  const change = staged.changes[0]!;
  assert.equal(change.kind, "modified");
  assert.equal(change.added, 1);
  assert.equal(change.removed, 1);
  assert.match(change.diff, /^--- a\/src\/lib\/dew\.ts$/m);
  assert.match(change.after, /DEW = 0\.25/);
});

later("a path that does not exist is proposed as a new file", async () => {
  const staged = await stageEdits(
    [{ path: "src/lib/price.ts", content: "export const PRICE = 1;\n" }],
    editContext()
  );
  assert.equal(staged.changes[0]?.kind, "created");
  assert.match(staged.changes[0]!.diff, /^--- \/dev\/null$/m);
});

later("ignored and escaping paths are refused before anything is read", async () => {
  const staged = await stageEdits(
    [
      { path: "package-lock.json", content: "{}" },
      { path: "../etc/passwd", content: "x" },
      { path: "/etc/passwd", content: "x" },
    ],
    editContext()
  );
  assert.equal(staged.changes.length, 0);
  assert.equal(staged.rejected.length, 3);
});

later("two edits to one file become one change against the base commit", async () => {
  const staged = await stageEdits(
    [
      { path: "src/lib/dew.ts", old_string: "0.5", new_string: "0.25" },
      { path: "src/lib/dew.ts", old_string: '"code"', new_string: '"code", "fast"' },
    ],
    editContext()
  );
  assert.equal(staged.changes.length, 1);
  const change = staged.changes[0]!;
  assert.equal(change.added, 2);
  assert.equal(change.removed, 2);
  assert.match(change.after, /0\.25/);
  assert.match(change.after, /"fast"/);
});

later("a diff supplied by the model is ignored in favour of the computed one", async () => {
  const staged = await stageEdits(
    [
      {
        path: "src/lib/dew.ts",
        old_string: "0.5",
        new_string: "0.25",
        diff: "--- a/fake\n+++ b/fake\n",
      },
    ],
    editContext()
  );
  const change = staged.changes[0]!;
  assert.doesNotMatch(change.diff, /fake/);
  assert.match(change.diff, /\+export const DEW = 0\.25;/);
});

later("a file past the read cap is not diffed, because the diff would lie", async () => {
  const staged = await stageEdits(
    [{ path: "src/lib/dew.ts", content: "x\n" }],
    editContext({ "src/lib/dew.ts": DEW_FILE }, { readBase: async () => ({ text: DEW_FILE, truncated: true }) })
  );
  assert.equal(staged.changes.length, 0);
  assert.match(staged.rejected[0]!.reason, /read cap/);
});

later("an edit that changes nothing stages nothing", async () => {
  const staged = await stageEdits([{ path: "src/lib/dew.ts", content: DEW_FILE }], editContext());
  assert.equal(staged.changes.length, 0);
  assert.match(staged.rejected[0]!.reason, /nothing to change/i);
});

later("one call proposes at most the cap and says what was left out", async () => {
  const edits = Array.from({ length: MAX_EDITS_PER_CALL + 2 }, (_, index) => ({
    path: `src/new-${index}.ts`,
    content: `export const N${index} = ${index};\n`,
  }));
  const staged = await stageEdits(edits, editContext({}));
  assert.equal(staged.changes.length, MAX_EDITS_PER_CALL);
  assert.ok(staged.rejected.some((entry) => /Only the first/.test(entry.reason)));
});

later("propose_edits stages through the tool and reports the derived diff", async () => {
  const result = await runTool(
    {
      id: "1",
      name: "propose_edits",
      argumentJson: JSON.stringify({
        edits: [{ path: "src/lib/dew.ts", old_string: "0.5", new_string: "0.25" }],
      }),
    },
    context({ propose: (raw) => stageEdits(raw, editContext()) })
  );
  assert.equal(result.ok, true);
  assert.match(result.summary, /Proposed 1 file · \+1 −1/);
  assert.match(result.content, /\+export const DEW = 0\.25;/);
  assert.match(result.content, /Nothing has been committed/);
});

later("propose_edits explains an edit it could not apply", async () => {
  const result = await runTool(
    {
      id: "1",
      name: "propose_edits",
      argumentJson: JSON.stringify({
        edits: [{ path: "src/lib/dew.ts", old_string: "not there", new_string: "x" }],
      }),
    },
    context({ propose: (raw) => stageEdits(raw, editContext()) })
  );
  assert.equal(result.ok, false);
  assert.match(result.content, /does not appear/);
});

later("propose_edits refuses rather than pretending when staging is not wired", async () => {
  const result = await runTool({ id: "1", name: "propose_edits", argumentJson: '{"edits":[]}' }, context());
  assert.equal(result.ok, false);
  assert.match(result.content, /cannot stage/i);
});

later("a step runs the proposal the model asked for and returns it for review", async () => {
  // End to end through runAgentStep with a stubbed model and GitHub: this is
  // the wiring the unit tests above cannot see. Nothing in it can write.
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  clearRepoCache();

  const realFetch = globalThis.fetch;
  const modelBodies: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/git/trees/")) {
      return new Response(
        JSON.stringify({
          tree: [{ path: "src/lib/dew.ts", type: "blob", sha: "blob1", size: DEW_FILE.length }],
          truncated: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.includes("/git/blobs/")) {
      return new Response(
        JSON.stringify({ content: Buffer.from(DEW_FILE, "utf8").toString("base64"), encoding: "base64" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    modelBodies.push(JSON.parse(String(init?.body ?? "{}")) as (typeof modelBodies)[number]);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "propose_edits",
                    arguments: JSON.stringify({
                      edits: [{ path: "src/lib/dew.ts", old_string: "0.5", new_string: "0.25" }],
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const result = await runAgentStep({
      authorization: null,
      uid: "user-1",
      project: {
        id: "abc123abc123",
        repoFullName: "owner/repo",
        defaultBranch: "main",
        baseSha: "f".repeat(40),
      },
      token: "gho_test",
      history: [{ role: "user", content: "lower the dew price" }],
    });

    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]?.tool, "propose_edits");
    assert.match(result.steps[0]!.label, /Proposed 1 file/);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0]?.path, "src/lib/dew.ts");
    assert.equal(result.proposals[0]?.kind, "modified");
    assert.match(result.proposals[0]!.diff, /^\+export const DEW = 0\.25;$/m);
    assert.equal(result.done, false, "a tool call means the client steps again");
    assert.equal(result.transcript.at(-1)?.role, "tool");
    assert.equal(result.transcript.at(-1)?.name, "propose_edits");
    assert.deepEqual(
      modelBodies[0]?.tools?.map((tool) => tool.function?.name),
      ["list_files", "read_file", "search_code", "propose_edits"]
    );
  } finally {
    globalThis.fetch = realFetch;
    clearRepoCache();
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

// ── turn state ──────────────────────────────────────────────────────────────
console.log("\nturn state");

const project = {
  uid: "user-1",
  projectId: "abc123abc123",
  repoFullName: "owner/repo",
  baseSha: "f".repeat(40),
};

test("a new turn is charged once and starts at one step", () => {
  const { state } = createTurn({ ...project, usage: { prompt: 1000, completion: 200 } });
  assert.equal(state.steps, 1);
  assert.equal(state.charged, true);
  assert.equal(state.tools, "propose");
  assert.equal(state.prompt, 1000);
  assert.equal(state.completion, 200);
});

test("a turn token verifies for its own user and project", () => {
  const { token } = createTurn({ ...project, usage: { prompt: 1, completion: 1 } });
  const state = readTurn(token, { uid: "user-1", projectId: "abc123abc123" });
  assert.ok(state);
});

test("a turn token is useless to another user", () => {
  const { token } = createTurn({ ...project, usage: { prompt: 1, completion: 1 } });
  assert.equal(readTurn(token, { uid: "user-2", projectId: "abc123abc123" }), null);
});

test("a turn token is useless for another project", () => {
  const { token } = createTurn({ ...project, usage: { prompt: 1, completion: 1 } });
  assert.equal(readTurn(token, { uid: "user-1", projectId: "000000000000" }), null);
});

test("an unsigned or edited token is refused", () => {
  const { token } = createTurn({ ...project, usage: { prompt: 1, completion: 1 } });
  assert.equal(readTurn(`${token}x`, { uid: "user-1", projectId: "abc123abc123" }), null);
  assert.equal(readTurn("", { uid: "user-1", projectId: "abc123abc123" }), null);
  assert.equal(readTurn(undefined, { uid: "user-1", projectId: "abc123abc123" }), null);

  const body = Buffer.from(
    JSON.stringify({ ...createTurn({ ...project, usage: { prompt: 1, completion: 1 } }).state, steps: 0 }),
    "utf8"
  ).toString("base64url");
  const signature = token.slice(token.lastIndexOf(".") + 1);
  assert.equal(readTurn(`${body}.${signature}`, { uid: "user-1", projectId: "abc123abc123" }), null);
});

test("an expired turn is refused", () => {
  const { token, state } = createTurn({ ...project, usage: { prompt: 1, completion: 1 }, now: 1_000 });
  assert.ok(readTurn(token, { uid: "user-1", projectId: "abc123abc123", now: state.exp - 1 }));
  assert.equal(readTurn(token, { uid: "user-1", projectId: "abc123abc123", now: state.exp }), null);
});

test("steps stop at the cap however many times they are advanced", () => {
  let { state } = createTurn({ ...project, usage: { prompt: 10, completion: 10 } });
  for (let index = 0; index < MAX_STEPS + 5; index += 1) {
    state = advanceTurn(state, { prompt: 10, completion: 10 });
  }
  assert.equal(state.steps, MAX_STEPS);
  assert.equal(turnExhausted(state), true);
});

test("the token budget also ends a turn", () => {
  const { state } = createTurn({ ...project, usage: { prompt: MAX_TURN_TOKENS, completion: 0 } });
  assert.equal(turnExhausted(state), true);
});

test("advancing a turn never extends its expiry", () => {
  const { state } = createTurn({ ...project, usage: { prompt: 1, completion: 1 }, now: 1_000 });
  const later = advanceTurn(state, { prompt: 1, completion: 1 }, 1_000_000);
  assert.ok(later.exp <= state.exp);
});

test("a re-signed state still verifies", () => {
  const { state } = createTurn({ ...project, usage: { prompt: 1, completion: 1 } });
  const advanced = advanceTurn(state, { prompt: 5, completion: 5 });
  const reread = readTurn(signTurn(advanced), { uid: project.uid, projectId: project.projectId });
  assert.equal(reread?.steps, 2);
  assert.equal(reread?.prompt, 6);
});

test("a turn issued before proposals existed still verifies", () => {
  const { state } = createTurn({ ...project, usage: { prompt: 1, completion: 1 } });
  const legacy = { ...state, tools: "read-only" as const };
  assert.ok(readTurn(signTurn(legacy), { uid: project.uid, projectId: project.projectId }));
});

test("a turn token claiming a write capability is refused", () => {
  const { state } = createTurn({ ...project, usage: { prompt: 1, completion: 1 } });
  const forged = { ...state, tools: "write" as never };
  assert.equal(readTurn(signTurn(forged), { uid: project.uid, projectId: project.projectId }), null);
});

// ── same-origin guard ───────────────────────────────────────────────────────
console.log("\nsame origin");

const headers = (values: Record<string, string>) => new Headers(values);

test("a request with no origin is allowed", () => {
  assert.equal(isSameOriginRequest(headers({ host: "example.com" })), true);
});

test("the page's own origin is allowed", () => {
  assert.equal(isSameOriginRequest(headers({ host: "example.com", origin: "https://example.com" })), true);
});

test("a proxy's forwarded host is honoured", () => {
  assert.equal(
    isSameOriginRequest(
      headers({ host: "internal:3000", "x-forwarded-host": "example.com", origin: "https://example.com" })
    ),
    true
  );
});

test("another site is refused", () => {
  assert.equal(isSameOriginRequest(headers({ host: "example.com", origin: "https://evil.test" })), false);
});

test("an opaque origin is refused", () => {
  assert.equal(isSameOriginRequest(headers({ host: "example.com", origin: "null" })), false);
});

test("an unparseable origin is refused", () => {
  assert.equal(isSameOriginRequest(headers({ host: "example.com", origin: "not a url" })), false);
});

// ── source contracts ────────────────────────────────────────────────────────
console.log("\nsource contracts");

test("the GitHub client only ever GETs", () => {
  const source = read("lib/github/client.ts");
  assert.doesNotMatch(source, /method:\s*["'`](POST|PUT|PATCH|DELETE)/i, "a write verb in the read client");
  assert.doesNotMatch(source, /\/git\/blobs`?\s*,\s*\{[\s\S]{0,40}method/, "no blob writes");
});

test("the step route charges before it reads a model", () => {
  const source = read("app/api/agent/step/route.ts");
  // Call sites, not imports: both names appear in the import block above.
  const charge = source.indexOf("canAfford(dewState.balance");
  const step = source.lastIndexOf("await runAgentStep(");
  assert.ok(charge > 0, "the route must check the balance");
  assert.ok(step > charge, "the balance check must come before the model call");
  assert.match(source, /isSameOriginRequest/);
});

test("no route hands a GitHub token back to the browser", () => {
  for (const path of [
    "app/api/github/status/route.ts",
    "app/api/github/repos/route.ts",
    "app/api/projects/route.ts",
  ]) {
    assert.doesNotMatch(read(path), /token:\s*link\.token|token:\s*viewer/, `${path} must not serialise a token`);
  }
});

test("the proposal module cannot reach GitHub", () => {
  const edits = read("lib/agent/edits.ts");
  assert.doesNotMatch(edits, /fetch\(|api\.github\.com|Authorization|githubFetch/, "staging must not talk to GitHub");
  assert.doesNotMatch(read("lib/agent/tools.ts"), /from "@\/lib\/github\/client"/, "a tool must not hold the client");
});

test("the step route returns proposals and contains no GitHub write", () => {
  const source = read("app/api/agent/step/route.ts");
  assert.match(source, /proposals: result\.proposals/);
  assert.doesNotMatch(source, /git\/blobs|git\/trees|git\/commits|git\/refs|\/pulls/);
});

test("the connection and the project are owner-scoped in the rules", () => {
  const rules = JSON.parse(read("database.rules.json")) as {
    rules: Record<string, unknown>;
  };
  const users = rules.rules.users as Record<string, unknown>;
  const uid = users.$uid as Record<string, unknown>;
  assert.ok(uid.github, "users/{uid}/github must exist in the rules");
  assert.match(JSON.stringify(uid.github), /auth\.uid === \$uid/);

  const projects = rules.rules.projects as Record<string, unknown>;
  assert.equal(projects[".read"], false, "projects must not be world-readable");
  assert.equal(projects[".write"], false);
  assert.match(JSON.stringify(projects.$uid), /auth\.uid === \$uid/);
});

test("the deployment is told which keys GitHub needs", () => {
  const env = read(".env.example");
  assert.match(env, /^GITHUB_TOKEN_KEY=/m);
  assert.match(env, /^AGENT_TURN_SECRET=/m);
});

(async () => {
  for (const [name, fn] of deferred) await atest(name, fn);
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})();
