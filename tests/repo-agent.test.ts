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
import { clearRepoCache, loadBlob, loadTree } from "../lib/github/cache";
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
import { GithubError, type GithubTreeEntry } from "../lib/github/client";
import { commitChanges } from "../lib/github/commit";
import {
  branchFor,
  buildChangeSet,
  changeSetHash,
  commitGate,
  messageFor,
  normalizeApproval,
  normalizeChangeSet,
  signApproval,
  type ChangeSet,
} from "../lib/changesets";
import {
  GITHUB_CONNECTION_COOKIE,
  openGithubConnection,
  resolveGithubLink,
  sealGithubConnection,
} from "../lib/github/store";
import {
  authorizeUrl,
  createOAuthState,
  exchangeCode,
  githubOAuthConfig,
  githubOAuthConfigured,
  looksLikeGithubToken,
  oauthCallbackUrl,
  safeReturnPath,
  signOAuthState,
  verifyOAuthState,
} from "../lib/github/oauth";
import {
  CONNECTION_LABEL_MAX,
  assessPat,
  describeScopes,
  isConnectionId,
  normalizeConnectionLabel,
  parseScopes,
  recoveryFor,
} from "../lib/github/pat";
// The id needs a hash, so it lives with the server-only storage module. The
// browser-readable half of the same feature stays free of Node built-ins.
import { connectionIdFor } from "../lib/github/connections";

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

// ── change sets and the commit invariant ────────────────────────────────────
console.log("\nchangesets");

const repo = {
  id: "abc123abc123",
  repoFullName: "owner/repo",
  defaultBranch: "main",
  baseSha: "f".repeat(40),
};

const DEW_AFTER = DEW_FILE.replace("0.5", "0.25");
const DEW_DIFF = "--- a/src/lib/dew.ts\n+++ b/src/lib/dew.ts\n@@ -1 +1 @@\n-export const DEW = 0.5;\n+export const DEW = 0.25;";

function builtChangeSet(now = Date.now()): ChangeSet {
  const changeSet = buildChangeSet({
    project: repo,
    proposals: [
      {
        path: "src/lib/dew.ts",
        kind: "modified",
        added: 1,
        removed: 1,
        diff: DEW_DIFF,
        after: DEW_AFTER,
        bytes: Buffer.byteLength(DEW_AFTER, "utf8"),
      },
    ],
    now,
  });
  assert.ok(changeSet, "a proposal with a diff must produce a change set");
  return changeSet;
}

test("the hash covers the contents, not the order they were proposed in", () => {
  const a = changeSetHash([{ path: "a.ts", after: "one" }, { path: "b.ts", after: "two" }]);
  const b = changeSetHash([{ path: "b.ts", after: "two" }, { path: "a.ts", after: "one" }]);
  const changed = changeSetHash([{ path: "a.ts", after: "one!" }, { path: "b.ts", after: "two" }]);
  assert.equal(a, b);
  assert.notEqual(a, changed);
});

test("a branch is derived, name-safe and cannot be the default branch", () => {
  assert.equal(branchFor("owner/repo", "0123456789abcdef0123"), "agent/repo-012345");
  assert.equal(branchFor("owner/My Cool Repo", "0123456789abcdef0123"), "agent/my-cool-repo-012345");
  assert.equal(branchFor("owner/---", "0123456789abcdef0123"), "agent/repo-012345");
  for (const name of ["main", "master", "", "feature/x"]) {
    assert.equal(branchFor(`owner/${name}`, "0123456789abcdef0123").startsWith("agent/"), true);
  }
});

test("a proposed change set is signed and starts as proposed", () => {
  const changeSet = builtChangeSet();
  assert.equal(changeSet.status, "proposed");
  assert.equal(changeSet.v, 1);
  assert.match(changeSet.id, /^[0-9a-f]{20}$/);
  assert.equal(changeSet.hash, changeSetHash(changeSet.files));
  assert.equal(changeSet.branch, branchFor("owner/repo", changeSet.id));
  assert.equal(changeSet.exp, changeSet.createdAt + 6 * 60 * 60_000);
  assert.ok(changeSet.sig.includes("."), "the signature is a signed payload");
  assert.equal(messageFor([{ path: "src/lib/dew.ts" }]), "Openmi: update src/lib/dew.ts");
  assert.match(messageFor([{ path: "a" }, { path: "b" }]), /update 2 files/);
});

test("a stored change set round-trips through the database's JSON", () => {
  const changeSet = builtChangeSet();
  const reread = normalizeChangeSet(JSON.parse(JSON.stringify(changeSet)));
  assert.deepEqual(reread, changeSet);
});

test("one changed byte in the row invalidates the hash and the change", () => {
  const row = JSON.parse(JSON.stringify(builtChangeSet())) as ChangeSet;
  row.files[0]!.after = row.files[0]!.after.replace("0.25", "9.99");
  assert.equal(normalizeChangeSet(row), null, "a rewritten file must not verify");
});

test("edited signed fields are refused, even with the signature intact", () => {
  for (const edit of [
    (row: ChangeSet) => {
      row.branch = "agent/elsewhere-abcdef";
    },
    (row: ChangeSet) => {
      row.baseSha = "e".repeat(40);
    },
    (row: ChangeSet) => {
      row.exp += 86_400_000;
    },
    (row: ChangeSet) => {
      row.message = "Openmi: something else";
    },
  ]) {
    const row = JSON.parse(JSON.stringify(builtChangeSet())) as ChangeSet;
    edit(row);
    assert.equal(normalizeChangeSet(row), null);
  }
});

const withStatus = (changeSet: ChangeSet, status: ChangeSet["status"]): ChangeSet => ({ ...changeSet, status });

test("status alone is never enough to commit anything", () => {
  // Status is a label, not a signature: a row claiming `approved` with no
  // approval record is refused, which is the whole point of signing one.
  const approvedRow = withStatus(builtChangeSet(), "approved");
  assert.ok(normalizeChangeSet(JSON.parse(JSON.stringify(approvedRow))), "the row still verifies");
  const gate = commitGate({ changeSet: approvedRow, approval: null, existingCommit: null });
  assert.equal(gate.ok, false);
  assert.equal(gate.ok ? "" : gate.detail, "no-approval");
});

test("an unapproved change cannot be committed", () => {
  const gate = commitGate({ changeSet: builtChangeSet(), approval: null, existingCommit: null });
  assert.equal(gate.ok, false);
  assert.equal(gate.ok ? 0 : gate.status, 403);
  assert.equal(gate.ok ? "" : gate.detail, "not-approved");
});

test("an approval is signed and round-trips", () => {
  const changeSet = builtChangeSet();
  const approval = signApproval(changeSet, changeSet.createdAt + 5_000);
  assert.deepEqual(normalizeApproval(JSON.parse(JSON.stringify(approval))), approval);
  assert.equal(approval.changeSetId, changeSet.id);
  assert.equal(approval.hash, changeSet.hash);
});

test("an approval cannot be edited after the fact", () => {
  const changeSet = builtChangeSet();
  const row = JSON.parse(JSON.stringify(signApproval(changeSet))) as Record<string, unknown>;
  row.at = Number(row.at) + 1;
  assert.equal(normalizeApproval(row), null);
});

test("an approval for another change is refused", () => {
  const changeSet = builtChangeSet();
  const approval = signApproval(changeSet);
  const other = withStatus({ ...changeSet, hash: changeSetHash([{ path: "other.ts", after: "x" }]) }, "approved");
  const gate = commitGate({ changeSet: other, approval, existingCommit: null });
  assert.equal(gate.ok, false);
  assert.equal(gate.ok ? "" : gate.detail, "approval-mismatch");
});

test("an approved change with its own approval may commit", () => {
  const changeSet = withStatus(builtChangeSet(), "approved");
  const approval = signApproval(changeSet);
  assert.deepEqual(commitGate({ changeSet, approval, existingCommit: null }), {
    ok: true,
    alreadyCommitted: null,
  });
});

test("an expired approval is refused with the reason", () => {
  const changeSet = withStatus(builtChangeSet(), "approved");
  const approval = signApproval(changeSet);
  const gate = commitGate({
    changeSet,
    approval,
    existingCommit: null,
    now: changeSet.exp,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.ok ? "" : gate.detail, "expired");
});

test("a repeat submit answers with the commit that already exists", () => {
  const changeSet = withStatus(builtChangeSet(), "committed");
  const record = {
    changeSetId: changeSet.id,
    sha: "a".repeat(40),
    branch: changeSet.branch,
    prUrl: "https://github.com/owner/repo/pull/1",
    at: changeSet.createdAt + 10_000,
  };
  const gate = commitGate({ changeSet, approval: null, existingCommit: record });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.ok ? gate.alreadyCommitted : null, record);
});

test("a change whose branch is not an agent branch is refused", () => {
  const changeSet = withStatus({ ...builtChangeSet(), branch: "main" }, "approved");
  const gate = commitGate({ changeSet, approval: signApproval(builtChangeSet()), existingCommit: null });
  assert.equal(gate.ok, false);
  assert.equal(gate.ok ? "" : gate.detail, "branch");
});

later("a commit writes blobs, then a tree on the base tree, then the commit, then the ref", async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const realFetch = globalThis.fetch;
  const sha = (letter: string) => letter.repeat(40);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname.replace("/repos/owner/repo", "");
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    const respond = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (path.startsWith("/git/commits/")) return respond({ tree: { sha: sha("1") } });
    if (path === "/git/blobs") return respond({ sha: sha("2") });
    if (path === "/git/trees") return respond({ sha: sha("3") });
    if (path === "/git/commits") return respond({ sha: sha("4") });
    if (path === "/git/refs") return respond({ ref: "refs/heads/agent/repo-012345" });
    if (path === "/pulls") return respond({ html_url: "https://github.com/owner/repo/pull/7" });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const outcome = await commitChanges({
      token: "gho_test",
      repoFullName: "owner/repo",
      baseSha: "f".repeat(40),
      branch: "agent/repo-012345",
      message: "Openmi: update src/lib/dew.ts",
      files: [{ path: "src/lib/dew.ts", content: DEW_AFTER }],
      defaultBranch: "main",
    });

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      [
        "GET /git/commits/ffffffffffffffffffffffffffffffffffffffff",
        "POST /git/blobs",
        "POST /git/trees",
        "POST /git/commits",
        "POST /git/refs",
        "POST /pulls",
      ]
    );

    const tree = calls.find((call) => call.path === "/git/trees")!.body!;
    assert.equal(tree.base_tree, sha("1"), "the new tree must be based on the base commit's tree");
    assert.deepEqual(tree.tree, [{ path: "src/lib/dew.ts", mode: "100644", type: "blob", sha: sha("2") }]);

    const commit = calls.find((call) => call.path === "/git/commits")!.body!;
    assert.deepEqual(commit.parents, ["f".repeat(40)], "the change is committed onto the commit it was based on");
    assert.equal(commit.tree, sha("3"));

    const ref = calls.find((call) => call.path === "/git/refs")!.body!;
    assert.equal(ref.ref, "refs/heads/agent/repo-012345");
    assert.equal(ref.sha, sha("4"));

    const pull = calls.find((call) => call.path === "/pulls")!.body!;
    assert.equal(pull.head, "agent/repo-012345");
    assert.equal(pull.base, "main");

    const blob = calls.find((call) => call.path === "/git/blobs")!.body!;
    assert.equal(Buffer.from(String(blob.content), "base64").toString("utf8"), DEW_AFTER);

    assert.equal(outcome.sha, sha("4"));
    assert.equal(outcome.prUrl, "https://github.com/owner/repo/pull/7");
  } finally {
    globalThis.fetch = realFetch;
  }
});

later("a cached repository read is never served to another connection", async () => {
  // The cache is keyed by repository and commit. Without the connection in the
  // key, a private file one account read could be handed to another account
  // before GitHub is ever asked whether it may see it.
  clearRepoCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        tree: [{ path: "secret/config.ts", type: "blob", sha: "blob1", size: 20 }],
        truncated: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const sha = "f".repeat(40);
    await loadTree("token-a", "owner/private", sha);
    await loadTree("token-a", "owner/private", sha);
    assert.equal(calls, 1, "one connection reuses its own read");

    await loadTree("token-b", "owner/private", sha);
    assert.equal(calls, 2, "a different connection must not inherit the bytes");
  } finally {
    globalThis.fetch = realFetch;
    clearRepoCache();
  }
});

later("a blob cached for one connection is fetched again for another", async () => {
  clearRepoCache();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ content: Buffer.from("const x = 1;\n", "utf8").toString("base64"), encoding: "base64" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    await loadBlob("token-a", "owner/private", "blob1");
    await loadBlob("token-b", "owner/private", "blob1");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
    clearRepoCache();
  }
});

later("a failed pull request still reports the commit that landed", async () => {
  const realFetch = globalThis.fetch;
  const sha = (letter: string) => letter.repeat(40);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const respond = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (path.includes("/git/commits/")) return respond({ tree: { sha: sha("1") } });
    if (path.endsWith("/git/blobs")) return respond({ sha: sha("2") });
    if (path.endsWith("/git/trees")) return respond({ sha: sha("3") });
    if (path.endsWith("/git/commits")) return respond({ sha: sha("4") });
    if (path.endsWith("/git/refs")) return respond({});
    return new Response("no pull requests here", { status: 500 });
  }) as typeof fetch;

  try {
    const outcome = await commitChanges({
      token: "gho_test",
      repoFullName: "owner/repo",
      baseSha: "f".repeat(40),
      branch: "agent/repo-012345",
      message: "Openmi: update one file",
      files: [{ path: "a.ts", content: "x\n" }],
      defaultBranch: "main",
    });
    assert.equal(outcome.sha, sha("4"), "the commit is real even when the PR is not");
    assert.equal(outcome.prUrl, null);
    assert.ok(outcome.prError);
  } finally {
    globalThis.fetch = realFetch;
  }
});

later("a commit to a non-agent branch is refused before GitHub is called", async () => {
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      commitChanges({
        token: "gho_test",
        repoFullName: "owner/repo",
        baseSha: "f".repeat(40),
        branch: "main",
        message: "Openmi: push straight to main",
        files: [{ path: "a.ts", content: "x\n" }],
        defaultBranch: "main",
      }),
      (error: unknown) => error instanceof GithubError && error.status === 403
    );
    assert.equal(called, false, "the refusal must not reach GitHub");
  } finally {
    globalThis.fetch = realFetch;
  }
});

later("a path that escapes the repository is refused before anything is written", async () => {
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      commitChanges({
        token: "gho_test",
        repoFullName: "owner/repo",
        baseSha: "f".repeat(40),
        branch: "agent/repo-012345",
        message: "Openmi: escape",
        files: [{ path: "../outside.ts", content: "x\n" }],
        defaultBranch: "main",
      })
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── GitHub OAuth, the door that needs no Firebase console change ────────────
console.log("\ngithub oauth");

const OAUTH_KEY = "9f".repeat(32);

/** Sets an environment value and hands back the undo. */
function withEnv(values: Record<string, string | undefined>): () => void {
  const before = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("the OAuth App needs both values, and a key to seal the result", () => {
  const restore = withEnv({
    GITHUB_CLIENT_ID: undefined,
    GITHUB_CLIENT_SECRET: undefined,
    GITHUB_TOKEN_KEY: undefined,
  });
  try {
    assert.equal(githubOAuthConfig(), null);
    assert.equal(githubOAuthConfigured(), false);

    process.env.GITHUB_CLIENT_ID = "client-id";
    assert.equal(githubOAuthConfig(), null, "a client id alone cannot exchange a code");

    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    assert.deepEqual(githubOAuthConfig(), { clientId: "client-id", clientSecret: "client-secret" });
    assert.equal(
      githubOAuthConfigured(),
      false,
      "without GITHUB_TOKEN_KEY the callback could not seal the token"
    );

    process.env.GITHUB_TOKEN_KEY = OAUTH_KEY;
    assert.equal(githubOAuthConfigured(), true);
  } finally {
    restore();
  }
});

test("a return path is app-relative or it is the root", () => {
  assert.equal(safeReturnPath("/"), "/");
  assert.equal(safeReturnPath("/?chat=1"), "/?chat=1");
  for (const value of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "javascript:alert(1)",
    "",
    null,
    undefined,
    42,
    "a".repeat(500),
  ]) {
    assert.equal(safeReturnPath(value), "/", `expected the root for ${String(value)}`);
  }
});

test("a state is signed for one account and expires", () => {
  const restore = withEnv({ GITHUB_TOKEN_KEY: OAUTH_KEY });
  try {
    const state = createOAuthState("uid-1", { now: 1_000 });
    const signed = signOAuthState(state);
    assert.ok(signed);

    const read = verifyOAuthState(signed, 2_000);
    assert.equal(read?.uid, "uid-1");
    assert.equal(read?.next, "/");
    assert.equal(verifyOAuthState(signed, state.exp), null, "an expired state is refused");
    assert.equal(verifyOAuthState(`${signed}x`, 2_000), null, "a tampered signature is refused");
    assert.equal(verifyOAuthState(null, 2_000), null);

    const forgedBody = Buffer.from(
      JSON.stringify({ ...state, uid: "uid-2" }),
      "utf8"
    ).toString("base64url");
    assert.equal(
      verifyOAuthState(`${forgedBody}.${signed!.split(".").pop()}`, 2_000),
      null,
      "the uid cannot be swapped after signing"
    );
  } finally {
    restore();
  }
});

test("the consent URL names the callback the OAuth App registered", () => {
  const url = new URL(
    authorizeUrl({ clientId: "abc123", clientSecret: "shh" }, "https://openmi.test", "signed-state")
  );
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "abc123");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("scope"), "repo");
  assert.equal(url.searchParams.get("redirect_uri"), "https://openmi.test/api/github/oauth/callback");
  assert.equal(oauthCallbackUrl("https://openmi.test/"), "https://openmi.test/api/github/oauth/callback");
  assert.ok(!url.toString().includes("shh"), "the client secret never travels in a URL");
});

test("GitHub tokens are accepted in both the modern and classic shapes", () => {
  assert.equal(looksLikeGithubToken(`gho_${'a'.repeat(36)}`), true);
  assert.equal(looksLikeGithubToken("a".repeat(40)), true);
  assert.equal(looksLikeGithubToken(`github_pat_${'a'.repeat(22)}`), true);
  for (const value of ["", "short", "has spaces in it and is long enough", null, undefined, 42]) {
    assert.equal(looksLikeGithubToken(value as string), false, `expected a refusal for ${String(value)}`);
  }
});

test("a connection cookie opens only for the account it was sealed for", () => {
  const restore = withEnv({ GITHUB_TOKEN_KEY: OAUTH_KEY });
  try {
    const link = {
      token: `gho_${'b'.repeat(36)}`,
      login: "octocat",
      scopes: "repo",
      linkedAt: 123,
    };
    const sealed = sealGithubConnection(link, "uid-1");
    assert.ok(sealed, "a keyed deployment can seal a connection");
    assert.ok(!sealed!.includes(link.token), "the token must not appear in the cookie");
    assert.deepEqual(openGithubConnection(sealed, "uid-1"), link);
    assert.equal(openGithubConnection(sealed, "uid-2"), null, "another account must not inherit it");
    assert.equal(openGithubConnection(sealed!.slice(0, -2), "uid-1"), null, "a truncated cookie is refused");
    assert.equal(openGithubConnection(null, "uid-1"), null);
    assert.equal(GITHUB_CONNECTION_COOKIE, "openmi_github");
  } finally {
    restore();
  }
});

later("a request resolves the sealed cookie for its own uid and falls through otherwise", async () => {
  const restore = withEnv({ GITHUB_TOKEN_KEY: OAUTH_KEY });
  try {
    const link = {
      token: `gho_${'c'.repeat(36)}`,
      login: "openmi",
      scopes: "repo",
      linkedAt: 456,
    };
    const sealed = sealGithubConnection(link, "uid-1")!;
    const req = {
      cookies: {
        get: (name: string) => (name === GITHUB_CONNECTION_COOKIE ? { value: sealed } : undefined),
      },
    };
    assert.deepEqual(await resolveGithubLink(req, null, "uid-1"), link);
    assert.equal(await resolveGithubLink(req, null, "uid-2"), null);
    assert.equal(await resolveGithubLink({ cookies: { get: () => undefined } }, null, "uid-1"), null);
  } finally {
    restore();
  }
});

later("a code exchange with no token in the body is a failure, not an empty success", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await exchangeCode(
      { clientId: "abc", clientSecret: "shh" },
      "stale-code",
      "https://openmi.test/api/github/oauth/callback"
    );
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /incorrect or expired/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

later("a successful code exchange returns the token and its scopes", async () => {
  const realFetch = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://github.com/login/oauth/access_token");
    assert.equal(init?.method, "POST");
    sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ access_token: `gho_${'d'.repeat(36)}`, scope: "repo", token_type: "bearer" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  try {
    const token = `gho_${'d'.repeat(36)}`;
    const result = await exchangeCode(
      { clientId: "abc", clientSecret: "shh" },
      "one-time-code",
      "https://openmi.test/api/github/oauth/callback"
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.token : "", token);
    assert.equal(result.ok ? result.scopes : "", "repo");
    assert.equal(sent.client_id, "abc");
    assert.equal(sent.client_secret, "shh");
    assert.equal(sent.code, "one-time-code");
    assert.equal(sent.redirect_uri, "https://openmi.test/api/github/oauth/callback");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── personal access tokens ──────────────────────────────────────────────────
console.log("\npersonal access tokens");

test("a connection id is derived from the login, so reconnecting replaces it", () => {
  assert.equal(connectionIdFor("Octocat"), connectionIdFor("octocat"), "case must not make a second entry");
  assert.equal(connectionIdFor(" octocat "), connectionIdFor("octocat"), "whitespace must not either");
  assert.match(connectionIdFor("octocat"), /^[0-9a-f]{12}$/);
  assert.notEqual(connectionIdFor("octocat"), connectionIdFor("hubot"), "two GitHub accounts are two entries");
  assert.equal(isConnectionId(connectionIdFor("octocat")), true);
  assert.equal(isConnectionId("not-an-id"), false);
  assert.equal(isConnectionId("../etc/passwd"), false);
});

test("a connection label is trimmed, collapsed and capped", () => {
  assert.equal(normalizeConnectionLabel("  work   laptop "), "work laptop");
  assert.equal(normalizeConnectionLabel(""), "GitHub", "a saved connection always has a label the rules accept");
  assert.equal(normalizeConnectionLabel("   "), "GitHub");
  assert.equal(normalizeConnectionLabel("x".repeat(80)).length, CONNECTION_LABEL_MAX);
  assert.equal(normalizeConnectionLabel(null, "octocat"), "octocat");
});

test("classic scopes are read from their header, and its absence is not \"no scopes\"", () => {
  assert.deepEqual(parseScopes("repo, read:user"), ["repo", "read:user"]);
  assert.deepEqual(parseScopes("repo"), ["repo"]);
  assert.deepEqual(parseScopes(""), []);
  assert.deepEqual(parseScopes(null), []);
  assert.deepEqual(parseScopes(undefined), []);
});

test("a token that cannot read repositories is given the exact scope to add", () => {
  const recovery = recoveryFor({ scopes: [], canReadRepos: false });
  assert.ok(recovery, "a broken token must produce a recovery, not silence");
  assert.equal(recovery!.level, "blocked");
  // The scope is spelled the way each kind of token presents it, because `repo`
  // does not exist on a fine-grained token and looking for it there is how
  // somebody creates the same broken token twice.
  assert.equal(recovery!.classicScope, "repo");
  assert.deepEqual(recovery!.fineGrained, ["Contents: Read", "Metadata: Read"]);
  assert.match(recovery!.tokenUrl, /github\.com\/settings\/tokens$/);
  assert.match(recovery!.fineGrainedUrl, /personal-access-tokens/);
  assert.match(recovery!.body, /cannot read any repository/);
});

test("a public-only token is told it cannot reach private repositories", () => {
  const recovery = recoveryFor({ scopes: ["public_repo", "read:user"], canReadRepos: true });
  assert.equal(recovery?.level, "limited");
  assert.match(recovery!.headline, /public repositories/);
  assert.equal(recovery!.classicScope, "repo");
});

test("a token with no repository scope at all is still given a fix", () => {
  const recovery = recoveryFor({ scopes: ["read:user"], canReadRepos: true });
  assert.equal(recovery?.level, "limited");
  assert.match(recovery!.headline, /missing repository scopes/);
});

test("a healthy token needs no recovery card", () => {
  assert.equal(recoveryFor({ scopes: ["repo"], canReadRepos: true }), null);
  assert.equal(recoveryFor({ scopes: [], canReadRepos: true }), null, "fine-grained, proven by the probe");
});

test("the warning a response carries is the recovery's own text", () => {
  // One source of truth: the card in the panel and the sentence in the response
  // cannot describe the same token differently.
  const input = { scopes: [] as string[], canReadRepos: false };
  assert.equal(assessPat(input).warning, recoveryFor(input)!.body);
});

test("a token that cannot list a repository is warned about, never refused", () => {
  const verdict = assessPat({ scopes: ["read:user"], canReadRepos: false });
  assert.equal(verdict.canReadRepos, false);
  assert.match(verdict.warning ?? "", /cannot read any repository/);
  // The door still stores what it was given; the warning is the whole outcome.
  assert.equal(typeof verdict.warning, "string");
});

test("a public-only token is warned about the private repositories it cannot reach", () => {
  const verdict = assessPat({ scopes: ["public_repo", "read:user"], canReadRepos: true });
  assert.match(verdict.warning ?? "", /public repositories/);
});

test("a token with the full scope needs no warning", () => {
  assert.equal(assessPat({ scopes: ["repo"], canReadRepos: true }).warning, null);
});

test("a fine-grained token is judged by the probe alone", () => {
  // Fine-grained tokens report no `x-oauth-scopes`, so an empty list means
  // "GitHub did not say", and the repository listing is the real answer.
  assert.equal(assessPat({ scopes: [], canReadRepos: true }).warning, null);
  assert.equal(describeScopes([], true), "fine-grained");
  assert.equal(describeScopes([], false), "no repository access");
  assert.equal(describeScopes(["repo"], true), "read and write repositories");
  assert.equal(describeScopes(["public_repo"], true), "public repositories only");
});

test("the panel's token helpers never import a Node built-in", () => {
  // The repository panel is a client component and reads scope and recovery
  // rules to render the card. One `node:` import there fails the production
  // build with a webpack error that typecheck and the tests cannot see.
  const source = read("lib/github/pat.ts");
  assert.doesNotMatch(source, /from "node:/, "pat.ts must stay importable by the browser");
});

test("the connection collection is owner-scoped in the rules", () => {
  const rules = JSON.parse(read("database.rules.json")) as {
    rules: { users: Record<string, Record<string, unknown>> };
  };
  const uid = rules.rules.users["$uid"]!;
  for (const node of ["githubConnections", "githubDefault"]) {
    assert.ok(uid[node], `users/{uid}/${node} must exist in the rules`);
    assert.match(JSON.stringify(uid[node]), /auth\.uid === \$uid/);
  }
  // The label is validated at the same limit the code normalizes to, so a stored
  // connection can never fail its own rules.
  assert.match(JSON.stringify(uid.githubConnections), /val\(\).length <= 40/);
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

test("every route that needs a GitHub token accepts the OAuth cookie", () => {
  // A connection made through GitHub's OAuth App lives in a cookie, not in the
  // database, so a route that still reads only the database would report "not
  // connected" for a connection the panel says is there.
  for (const path of [
    "app/api/github/status/route.ts",
    "app/api/github/repos/route.ts",
    "app/api/projects/route.ts",
    "app/api/projects/[id]/tree/route.ts",
    "app/api/projects/[id]/file/route.ts",
    "app/api/agent/step/route.ts",
    "app/api/changesets/[id]/approve/route.ts",
    "app/api/changesets/[id]/commit/route.ts",
  ]) {
    const source = read(path);
    assert.match(source, /resolveGithubLink\(/, `${path} must resolve the cookie connection`);
    assert.doesNotMatch(source, /\breadGithubLink\(/, `${path} must not read only the database`);
  }
});

test("the OAuth callback verifies its state before it trusts the account", () => {
  const source = read("app/api/github/oauth/callback/route.ts");
  assert.match(source, /verifyOAuthState\(/);
  assert.match(source, /exchangeCode\(/);
  assert.match(source, /httpOnly: true/);
  assert.match(source, /sameSite: "lax"/);
  assert.match(source, /GITHUB_CONNECTION_MAX_AGE_S/);
  // The return path comes from the signed state, never straight from the query.
  assert.doesNotMatch(source, /params\.get\("next"\)/);
});

test("the repository panel cannot stay on a bare \"checking\" forever", () => {
  const source = read("components/RepoPanel.tsx");
  // A bounded request, and a named state for every way it can fail.
  assert.match(source, /const REQUEST_TIMEOUT_MS/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /phase: "signed-out"/);
  assert.match(source, /phase: "error"/);
  // Both doors out of a dead end, plus the native OAuth start call.
  assert.match(source, /Continue with Google/); // present but hidden behind {false && ...} by owner choice
  assert.match(source, /github\/oauth\/start/);
  // The old rendering keyed on a null status rendered the spinner forever.
  assert.doesNotMatch(source, /!status \?/);
  // And an empty repository list says it is still loading, not that it is empty.
  assert.match(source, /setReposLoading\(true\)/);
  assert.match(source, /Reading your repositories/);
});

test("the OAuth start route requires a verified account", () => {
  const source = read("app/api/github/oauth/start/route.ts");
  assert.match(source, /isSameOriginRequest/);
  assert.match(source, /verifyCaller/);
  assert.match(source, /createOAuthState\(identity\.uid/);
  assert.doesNotMatch(source, /clientSecret\s*:/, "the secret must not be echoed to the browser");
});

test("editing a message in a repository chat goes through the agent", () => {
  // Ordinary chat has no repository access. An edit routed there would answer
  // the same words with a different, worse capability and no sign of it.
  const source = read("app/page.tsx");
  assert.match(source, /sendAgentMessage\(content, \{ editMessageId: messageId \}\)/);
  assert.match(source, /editMessageId\?: string/);
  assert.match(source, /options\?\.editMessageId/);
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

test("only one module can write to GitHub, and it names the branch it may write", () => {
  const commit = read("lib/github/commit.ts");
  assert.match(commit, /git\/blobs/);
  assert.match(commit, /git\/trees/);
  assert.match(commit, /git\/commits/);
  assert.match(commit, /git\/refs/);
  assert.match(commit, /\^agent\\\//, "the branch policy is enforced in the write module");

  // The read client stays read-only, and the agent's step route stays unable to
  // write. A proposal is persisted, not published.
  assert.doesNotMatch(read("lib/github/client.ts"), /method:\s*["'`](POST|PUT|PATCH|DELETE)/i);
  const step = read("app/api/agent/step/route.ts");
  assert.doesNotMatch(step, /git\/blobs|git\/trees|git\/commits|git\/refs|\/pulls/);
  assert.doesNotMatch(read("lib/agent/edits.ts"), /commitChanges|from "@\/lib\/github\/commit"/);
});

test("the commit route checks caller, origin, approval and the branch head", () => {
  const source = read("app/api/changesets/[id]/commit/route.ts");
  assert.match(source, /isSameOriginRequest/);
  assert.match(source, /verifyCaller/);
  assert.match(source, /commitGate\(/);
  assert.match(source, /getBranchHead\(/);
  assert.match(source, /permissions\?\.push/);
  assert.match(source, /readApproval\(/);
  assert.match(source, /readCommit\(/);
  // The stale refusal must mark the change and say which commit moved it.
  assert.match(source, /detail: "stale"/);
  assert.match(source, /"stale"/);
});

test("the approval route checks the same branch and permission before signing", () => {
  const source = read("app/api/changesets/[id]/approve/route.ts");
  assert.match(source, /isSameOriginRequest/);
  assert.match(source, /getBranchHead\(/);
  assert.match(source, /signApproval\(/);
  assert.match(source, /permissions\?\.push/);
  // Approving is not committing: this route must not reach the write module.
  assert.doesNotMatch(source, /commitChanges|git\/refs|\/pulls/);
});

test("change sets, approvals and commits are owner-scoped in the rules", () => {
  const rules = JSON.parse(read("database.rules.json")) as { rules: Record<string, Record<string, unknown>> };
  for (const node of ["changesets", "approvals", "commits"]) {
    const entry = rules.rules[node];
    assert.ok(entry, `${node} must exist in the rules`);
    assert.equal(entry[".read"], false, `${node} must not be world-readable`);
    assert.match(JSON.stringify(entry.$uid), /auth\.uid === \$uid/);
    assert.match(JSON.stringify(entry.$uid), /\$changeSetId/);
  }
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
