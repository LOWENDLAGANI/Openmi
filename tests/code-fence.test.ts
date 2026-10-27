// ── Openmi — tests for the code fence label ───────────────────────────────────
//
// This decides whether a code block is labelled with a file name or just a
// language. Getting it wrong is quiet and ugly: a path read as a language gives
// broken highlighting, and a language read as a path puts "ts" above the block as
// though it were a filename. Both look plausible and neither is right, so the
// rule is pinned down here.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFenceInfo } from "../lib/codeFence";
import { getModelDisplayName } from "../lib/models";
import { toOpenmiName } from "../lib/modelEngines";

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

console.log("\nnamed files");

test("a language and a path give both", () => {
  assert.deepEqual(parseFenceInfo("ts src/lib/thing.ts"), {
    language: "ts",
    path: "src/lib/thing.ts",
  });
});

test("the path may come first", () => {
  assert.deepEqual(parseFenceInfo("src/lib/thing.ts ts"), {
    language: "ts",
    path: "src/lib/thing.ts",
  });
});

test("a colon separator works", () => {
  assert.deepEqual(parseFenceInfo("typescript:app/page.tsx"), {
    language: "typescript",
    path: "app/page.tsx",
  });
});

test("a path on its own has no language", () => {
  assert.deepEqual(parseFenceInfo("src/app/page.tsx"), { language: "", path: "src/app/page.tsx" });
});

test("a bare filename with an extension is a path", () => {
  assert.equal(parseFenceInfo("index.html").path, "index.html");
});

test("a path with no extension still counts when it has a slash", () => {
  assert.equal(parseFenceInfo("src/Makefile").path, "src/Makefile");
});

console.log("\nordinary code blocks");

test("a plain language is not treated as a file name", () => {
  assert.deepEqual(parseFenceInfo("ts"), { language: "ts", path: null });
});

test("a shell fence is not treated as a file name", () => {
  assert.deepEqual(parseFenceInfo("bash"), { language: "bash", path: null });
});

test("an empty fence is safe", () => {
  assert.deepEqual(parseFenceInfo(""), { language: "", path: null });
});

test("whitespace-only is safe", () => {
  assert.deepEqual(parseFenceInfo("   "), { language: "", path: null });
});

test("c# and other punctuated languages survive", () => {
  assert.deepEqual(parseFenceInfo("c#"), { language: "c#", path: null });
});

console.log("\nmodel names");

test("each wire model maps to a Openmi name", () => {
  assert.equal(toOpenmiName("gemini-3.6-flash"), "Openmi V1");
  assert.equal(toOpenmiName("gemini-3.7-flash"), "Openmi V2");
  assert.equal(toOpenmiName("gemini-3.8-flash"), "Openmi V3");
  assert.equal(toOpenmiName("deepseek-flash"), "DeepSeek V4.1 Flash");
});

test("the router keeps its own name", () => {
  assert.equal(toOpenmiName("openrouter/auto"), "Openmi Auto");
});

test("the single Groq model answers under its real model name", () => {
  assert.equal(toOpenmiName("openai/gpt-oss-120b"), "GPT-OSS 120B");
});

test("a wire id never becomes the wire id", () => {
  const inputs = [
    undefined,
    "",
    "gemini-3.9-flash",
    "gemini-exp-1206",
    "gpt-4",
    "claude-3-5-sonnet",
    "openai/gpt-oss-20b",
    "some-unknown-model",
  ];
  for (const input of inputs) {
    const name = toOpenmiName(input);
    assert.ok(
      name === "Openmi" ||
        name.startsWith("Openmi ") ||
        name === "GPT-OSS 120B" ||
        name === "DeepSeek V4.1 Flash",
      `"${input}" became "${name}", which is not a product name`
    );
  }
});

test("a stored product name survives display unchanged", () => {
  for (const name of [
    "Openmi V1",
    "Openmi V2",
    "Openmi V3",
    "Openmi Auto",
    "Openmi Code",
    "GPT-OSS 120B",
    "DeepSeek V4.1 Flash",
  ]) {
    assert.equal(getModelDisplayName(name), name);
  }
});

test("a stored provider id from an old backup is not shown", () => {
  // A backup written before the rename carries raw ids. Restoring one must not
  // put a vendor name back on screen.
  assert.equal(getModelDisplayName("gemini-3.8-flash"), "Openmi");
  assert.equal(getModelDisplayName(undefined), "Openmi");
});

const VENDOR_WORDS = ["gemini", "openrouter", "groq", "gpt-4", "claude", "llama", "deepseek"];

// "GPT-OSS 120B" is the Code mode's display name, and "DeepSeek V4.1 Flash"
// the name of its own mode, so those are the vendor words allowed on screen.
// They go through this list rather than being dropped from VENDOR_WORDS, so a
// *different* display name that happens to contain a provider word is still
// caught — each exemption stays one name wide.
const SANCTIONED_DISPLAY_NAMES: string[] = ["GPT-OSS 120B", "DeepSeek V4.1 Flash"];

/**
 * The source with the sanctioned display names removed.
 *
 * Each name appears twice in lib/models.ts: once as the label shown in the UI
 * and once inside the OPENMI_NAME regex, where its dots are backslash-escaped.
 * Both spellings are removed so the scan below sees the rest of the file.
 */
function withoutSanctionedNames(source: string): string {
  return SANCTIONED_DISPLAY_NAMES.reduce((text, name) => {
    const pattern = name
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\./g, "(?:\\\\?\\.)");
    return text.replace(new RegExp(pattern, "gi"), "");
  }, source);
}

/** The vendor words this source would leak to the client. */
function vendorLeaks(source: string): string[] {
  const scanned = withoutSanctionedNames(source).toLowerCase();
  return VENDOR_WORDS.filter((word) => scanned.includes(word));
}

test("no provider name reaches a client module", () => {
  // The reason the catalog, the system prompt, and the wire ids are split into
  // server-only modules. Any of these files is compiled into the page bundle, so
  // a provider name written here is a provider name a user can read in the page
  // source — and, for anything stored on a message, in the backup they download.
  const clientModules = ["lib/models.ts", "lib/db.ts", "lib/types.ts", "components/ModelHealth.tsx"];
  for (const file of clientModules) {
    const leaks = vendorLeaks(readFileSync(join(process.cwd(), file), "utf8"));
    assert.deepEqual(
      leaks,
      [],
      `${file} mentions ${leaks.map((w) => `"${w}"`).join(", ")}, which would reach the client`
    );
  }
});

test("the guard still catches a provider id that reaches a client module", () => {
  // Proves the exemption is narrow. A wire model id pasted into a client
  // module is still found, so widening the exemption until it stopped
  // checking anything would not pass unnoticed.
  const leaks = vendorLeaks('const wire = "claude-3-5-sonnet";');
  assert.ok(
    leaks.includes("claude"),
    "the guard would no longer catch a planted provider id"
  );
});

console.log(
  failures === 0
    ? `\n${passes} passed\n`
    : `\n${passes} passed, ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);
