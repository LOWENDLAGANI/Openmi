// ── Mino — tests for the code fence label ───────────────────────────────────
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
import { toMinoName } from "../lib/modelEngines";

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

test("each wire model maps to a Mino name", () => {
  assert.equal(toMinoName("gemini-3.6-flash"), "Mino V1");
  assert.equal(toMinoName("gemini-3.7-flash"), "Mino V2");
  assert.equal(toMinoName("gemini-3.8-flash"), "Mino V3");
});

test("the router and image engine keep their own names", () => {
  assert.equal(toMinoName("openrouter/auto"), "Mino Auto");
  assert.equal(toMinoName("mino-canvas"), "Mino Canvas");
});

test("a wire id never becomes the wire id", () => {
  const inputs = [
    undefined,
    "",
    "gemini-3.9-flash",
    "gemini-exp-1206",
    "gpt-4",
    "claude-3-5-sonnet",
    "llama-3.3-70b-versatile",
    "some-unknown-model",
  ];
  for (const input of inputs) {
    const name = toMinoName(input);
    assert.ok(
      name === "Mino" || name.startsWith("Mino "),
      `"${input}" became "${name}", which is not a Mino name`
    );
  }
});

test("a stored Mino name survives display unchanged", () => {
  for (const name of ["Mino V1", "Mino V2", "Mino V3", "Mino Auto", "Mino Canvas"]) {
    assert.equal(getModelDisplayName(name), name);
  }
});

test("a stored provider id from an old backup is not shown", () => {
  // A backup written before the rename carries raw ids. Restoring one must not
  // put a vendor name back on screen.
  assert.equal(getModelDisplayName("gemini-3.8-flash"), "Mino");
  assert.equal(getModelDisplayName(undefined), "Mino");
});

const VENDOR_WORDS = ["gemini", "openrouter", "groq", "gpt-4", "claude", "llama", "deepseek"];

// The Opus and Fable personas are shown to the user under these names on
// purpose — the tilde marks them as a product name, and lib/models.ts says so
// where it defines them. They are not a leaked provider id, so the guard below
// ignores them. Every other spelling of a vendor word still fails, and the
// guard is deliberately narrow about which occurrences it forgives.
const SANCTIONED_DISPLAY_NAMES = ["~Claude Opus 5.5", "~Claude Fable 5.1"];

/**
 * The source with the sanctioned display names removed.
 *
 * Each name appears twice in lib/models.ts: once as the label shown in the UI
 * and once inside the MINO_NAME regex, where its dots are backslash-escaped.
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

test("the sanctioned display names are still the ones lib/models.ts uses", () => {
  // A renamed persona must not quietly turn the exemption above into a hole:
  // the guard forgives these exact strings, so a new one has to be listed.
  const source = readFileSync(join(process.cwd(), "lib/models.ts"), "utf8");
  for (const name of SANCTIONED_DISPLAY_NAMES) {
    assert.ok(
      source.includes(name),
      `lib/models.ts no longer uses "${name}"; update SANCTIONED_DISPLAY_NAMES to match`
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
