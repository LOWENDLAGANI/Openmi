// ── Openmi — the chat must not swallow the error it was given ───────────────
//
// The run routes answer a refused start with a sentence that names the migration
// to apply or the variable to set. The chat used to replace anything longer than
// 200 characters with "Something went wrong. Please try again.", so the fixable
// refusals arrived as the generic one — and the sentence that explained the
// missing service-role grant was 322 characters, longer than the sentence it
// replaced, which is what made a fixed bug look like a new one.
//
// These checks pin the boundary: machine output is hidden, prose is shown, and
// the real server sentences survive the round trip.
//
//   bun run test

import assert from "node:assert/strict";
import { looksLikePayload, sanitizeError } from "../lib/chatErrors";
import { runStartFailure } from "../lib/agentRuns";

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  \u2717 ${label}`);
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`    ${detail}`);
  }
}

console.log("\nchat errors");

check("the refusal to record a run reaches the reader with its migration named", () => {
  const { error } = runStartFailure("denied");
  assert.ok(error.length > 200, "this sentence is longer than the old cutoff");
  assert.equal(sanitizeError(error), error);
  assert.match(sanitizeError(error), /20261029000600_agent_runs_service_grants\.sql/);
});

check("every run-start refusal survives, not just the shortest", () => {
  for (const reason of ["missing-table", "denied", "no-key", "unconfigured"] as const) {
    const { error } = runStartFailure(reason);
    assert.equal(sanitizeError(error), error, `${reason} was rewritten`);
  }
});

check("a response body is still hidden", () => {
  assert.equal(
    sanitizeError('{"code":"42501","message":"permission denied for table agent_runs"}'),
    "Something went wrong. Please try again."
  );
  assert.equal(looksLikePayload('{"error":"nope"}'), true);
});

check("an HTML error page is still hidden", () => {
  assert.equal(sanitizeError("<html><body>502 Bad Gateway</body></html>"), "Something went wrong. Please try again.");
});

check("a stack trace is still hidden", () => {
  assert.equal(
    sanitizeError("TypeError: cannot read properties\n    at runStart (lib/agentRuns.ts:1:1)"),
    "Something went wrong. Please try again."
  );
});

check("a dump with no shape is hidden by length alone", () => {
  assert.equal(sanitizeError("x".repeat(601)), "Something went wrong. Please try again.");
});

check("the known causes keep their own sentences", () => {
  assert.equal(sanitizeError("TypeError: Failed to fetch"), "Connection issue. Please check your internet and try again.");
  assert.equal(sanitizeError("upstream timeout after 30s"), "The request timed out. Please try again.");
  assert.equal(sanitizeError("HTTP 401 Unauthorized"), "Something went wrong with authentication. Please try signing in again.");
  assert.equal(sanitizeError("rate limit reached, try later"), "Too many requests. Please wait a moment and try again.");
});

check("an exception object is read the same as its message", () => {
  assert.equal(sanitizeError(new Error("Failed to fetch")), "Connection issue. Please check your internet and try again.");
  assert.equal(sanitizeError(new Error("The run could not be recorded.")), "The run could not be recorded.");
});

check("nothing at all says nothing useful, so it says the generic sentence", () => {
  assert.equal(sanitizeError(""), "Something went wrong. Please try again.");
  assert.equal(sanitizeError("   "), "Something went wrong. Please try again.");
  assert.equal(sanitizeError(undefined), "Something went wrong. Please try again.");
  assert.equal(sanitizeError({ code: 500 }), "Something went wrong. Please try again.");
});

if (failed > 0) {
  console.log(`\nchat-errors: ${failed} check(s) failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nchat-errors: ${passed} checks passed`);
