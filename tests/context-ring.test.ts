// ── Openmi — tests for the composer's context ring ───────────────────────────
//
// The ring's whole job is to say one number and be believed. That makes it worth
// pinning down three things: the arithmetic never produces a percentage a ring
// cannot draw, the thresholds turn amber and red exactly where the plan says,
// and the denominator is a product budget rather than a provider's context
// window (which is both the wrong limit and a vendor name in the browser).
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTEXT_BUDGET,
  CONTEXT_FULL_PERCENT,
  CONTEXT_WARN_PERCENT,
  IMAGE_TOKEN_ESTIMATE,
  clampPercent,
  contextLabel,
  contextLevel,
  contextPercent,
  estimateContextUsage,
  formatTokens,
} from "../lib/contextBudget";

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

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

console.log("\npercentages a ring can draw");

test("a quarter-full conversation reads as 25%", () => {
  assert.equal(contextPercent(2500, 10_000), 25);
});

test("the plan's example is 83%", () => {
  assert.equal(contextPercent(25_000, CONTEXT_BUDGET), 83);
});

test("over budget clamps to 100 rather than drawing past the circle", () => {
  assert.equal(contextPercent(90_000, CONTEXT_BUDGET), 100);
});

test("nonsense never becomes a percentage", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -400]) {
    assert.equal(clampPercent(value), 0);
  }
  assert.equal(contextPercent(100, 0), 0);
  assert.equal(contextPercent(Number.NaN, CONTEXT_BUDGET), 0);
});

test("an empty conversation is zero, not undefined", () => {
  assert.equal(contextPercent(0, CONTEXT_BUDGET), 0);
});

console.log("\nthresholds");

test("amber starts exactly at the warn threshold", () => {
  assert.equal(contextLevel(0), "empty");
  assert.equal(contextLevel(1), "ok");
  assert.equal(contextLevel(CONTEXT_WARN_PERCENT - 1), "ok");
  assert.equal(contextLevel(CONTEXT_WARN_PERCENT), "warn");
  assert.equal(contextLevel(CONTEXT_FULL_PERCENT - 1), "warn");
  assert.equal(contextLevel(CONTEXT_FULL_PERCENT), "full");
  assert.equal(contextLevel(100), "full");
});

console.log("\nthe numerator");

test("the last request's prompt is the base, and the draft adds to it", () => {
  const usage = estimateContextUsage({ usedTokens: 25_000, draftText: "a".repeat(400) });
  assert.equal(usage.used, 25_100, "400 characters is about 100 tokens");
  assert.equal(usage.percent, 84);
});

test("attachments are counted, images at the documented estimate", () => {
  const usage = estimateContextUsage({
    usedTokens: 0,
    images: 2,
    documentChars: 400,
  });
  assert.equal(usage.used, IMAGE_TOKEN_ESTIMATE * 2 + 100);
});

test("a draft alone fills the ring before anything has been sent", () => {
  const usage = estimateContextUsage({ draftText: "x".repeat(CONTEXT_BUDGET * 4) });
  assert.equal(usage.used, CONTEXT_BUDGET);
  assert.equal(usage.percent, 100);
  assert.equal(usage.level, "full");
});

test("a new chat is empty and offers no breakdown rows", () => {
  const usage = estimateContextUsage({});
  assert.equal(usage.used, 0);
  assert.equal(usage.percent, 0);
  assert.equal(usage.level, "empty");
  assert.deepEqual(usage.parts, []);
});

test("remaining never goes negative", () => {
  assert.equal(estimateContextUsage({ usedTokens: 99_000 }).remaining, 0);
});

test("the breakdown names where the tokens are", () => {
  const labels = estimateContextUsage({ usedTokens: 500, draftText: "hello world", images: 1 }).parts.map(
    (part) => part.label
  );
  assert.deepEqual(labels, ["Last request", "Draft", "Attachments"]);
});

test("an unusable budget falls back to the product budget", () => {
  assert.equal(estimateContextUsage({ usedTokens: 100, budget: 0 }).budget, CONTEXT_BUDGET);
  assert.equal(estimateContextUsage({ usedTokens: 100, budget: Number.NaN }).budget, CONTEXT_BUDGET);
});

console.log("\nthe accessible label");

test("the ring's label carries the numbers, not an adjective", () => {
  const usage = estimateContextUsage({ usedTokens: 25_000 });
  const label = contextLabel(usage);
  assert.match(label, /83%/);
  assert.match(label, /25,000/);
  assert.match(label, /30,000/);
});

test("an empty context says so and still names the budget", () => {
  assert.match(contextLabel(estimateContextUsage({})), /empty/);
  assert.match(contextLabel(estimateContextUsage({})), /30,000/);
});

console.log("\nshort numbers");

test("token counts stay short enough for the chip", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(840), "840");
  assert.equal(formatTokens(1200), "1.2k");
  assert.equal(formatTokens(25_400), "25k");
});

console.log("\nsource contracts");

test("the budget is a product number, not a provider's window", () => {
  const source = read("lib/contextBudget.ts").toLowerCase();
  for (const word of ["gemini", "openrouter", "groq", "gpt-", "llama", "claude"]) {
    assert.ok(!source.includes(word), `the client-safe budget module mentions "${word}"`);
  }
});

test("the server serves the same budget to the composer", () => {
  const route = read("app/api/chat/route.ts");
  assert.match(route, /contextBudget: CONTEXT_BUDGET/, "GET /api/chat must send the budget");
  assert.match(route, /from "@\/lib\/contextBudget"/);
});

test("the ring is mounted by the composer and hidden on Focus home", () => {
  const composer = read("components/ChatInput.tsx");
  assert.match(composer, /<ContextRing/, "the composer must render the ring");
  // The header block is the only thing gated on `focus`, which is what keeps
  // the ring off the Focus home's composition.
  assert.match(composer, /\{!focus && \(\s*<div className="mb-1 flex items-center justify-end">/);
});

test("the ring is a focusable button with a breakdown popover", () => {
  const ring = read("components/ContextRing.tsx");
  assert.match(ring, /aria-expanded=\{open\}/);
  assert.match(ring, /contextLabel\(usage\)/);
  assert.match(ring, /role="dialog"/);
  assert.match(ring, /Start a new chat/);
});

console.log(
  failures === 0
    ? `\n${passes} passed\n`
    : `\n${passes} passed, ${failures} FAILED\n`
);

process.exit(failures === 0 ? 0 : 1);
