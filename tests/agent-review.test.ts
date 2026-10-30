// ── Openmi — tests for the pre-flight review ─────────────────────────────────
//
// The review is the only thing between a model's proposal and a person's
// approval, so two properties matter and both are tested here:
//
//   - it never invents a finding. A false error sends the agent back to fix
//     something that was never wrong, which is worse than saying nothing.
//   - it never hides the checks it actually ran. Static findings survive a
//     reviewer that declines to answer, and a `fix` verdict with no findings is
//     treated as a pass rather than as an unexplained objection.
//
//   bunx tsx tests/agent-review.test.ts
//
// Pure functions only: no network, no model, no repository.

import assert from "node:assert/strict";
import test from "node:test";
import type { StagedChange } from "../lib/agent/edits";
import {
  assembleReview,
  hasBlockingFinding,
  parseReview,
  repairRequest,
  reviewMessages,
  staticReview,
} from "../lib/agent/review";

function change(path: string, after: string): StagedChange {
  return {
    path,
    kind: "modified",
    added: 1,
    removed: 0,
    diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n ${after.split("\n")[0] ?? ""}`,
    after,
    bytes: after.length,
  };
}

test("a sound change produces no findings", () => {
  const findings = staticReview({
    changes: [change("lib/a.ts", 'import { b } from "./b";\nexport const a = b;\n')],
    repoPaths: ["lib/a.ts", "lib/b.ts"],
  });
  assert.deepEqual(findings, []);
});

test("a resolved root alias counts as resolved", () => {
  const findings = staticReview({
    changes: [change("app/page.tsx", 'import { thing } from "@/lib/thing";\nexport default thing;\n')],
    repoPaths: ["app/page.tsx", "lib/thing.ts"],
  });
  assert.deepEqual(findings, []);
});

test("an import of a file the commit does not have is a warning, not an error", () => {
  const findings = staticReview({
    changes: [change("lib/a.ts", 'import { missing } from "./gone";\n')],
    repoPaths: ["lib/a.ts"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "warning");
  assert.match(findings[0]?.message ?? "", /\.\/gone/);
});

test("malformed JSON is an error with the parser's own words", () => {
  const findings = staticReview({
    changes: [change("package.json", '{\n  "name": "openmi",\n}')],
    repoPaths: ["package.json"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "error");
  assert.match(findings[0]?.message ?? "", /JSON/);
});

test("an unbalanced bracket in a script is an error", () => {
  const findings = staticReview({
    changes: [change("lib/a.ts", "export function a() {\n  return 1;\n")],
    repoPaths: ["lib/a.ts"],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "error");
  assert.match(findings[0]?.message ?? "", /unclosed/);
});

test("JSX text with an apostrophe never fabricates a bracket finding", () => {
  // The scanner cannot tell `don't` from the start of a string, so it stops
  // rather than guessing. A missed finding is honest; a phantom one is not.
  const findings = staticReview({
    changes: [
      change("app/page.tsx", "export function Page() {\n  return <p>Don't panic, it's fine</p>;\n}\n"),
    ],
    repoPaths: ["app/page.tsx"],
  });
  assert.deepEqual(findings, []);
});

test("conflict markers are reported as an error", () => {
  const findings = staticReview({
    changes: [change("lib/a.ts", "<<<<<<< HEAD\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> main\n")],
    repoPaths: ["lib/a.ts"],
  });
  assert.ok(findings.some((finding) => finding.severity === "error" && /conflict/.test(finding.message)));
});

test("an emptied file is an error rather than a silent deletion", () => {
  const findings = staticReview({ changes: [change("lib/a.ts", "  \n")], repoPaths: ["lib/a.ts"] });
  assert.equal(findings[0]?.severity, "error");
  assert.match(findings[0]?.message ?? "", /empty/);
});

test("a reviewer's answer is read out of fences, and unknown paths are re-pointed", () => {
  const raw = [
    "Here is my review:",
    "```json",
    '{"verdict":"fix","summary":"One real bug.","findings":[{"path":"ghost.ts","severity":"error","message":"`a` is undefined"}]}',
    "```",
  ].join("\n");
  const review = parseReview(raw, [change("lib/a.ts", "export const a = 1;\n")]);
  assert.equal(review?.verdict, "fix");
  assert.equal(review?.findings.length, 1);
  assert.equal(review?.findings[0]?.path, "lib/a.ts");
  assert.equal(review?.findings[0]?.severity, "error");
});

test("a fix verdict with nothing to fix is a pass", () => {
  const review = parseReview('{"verdict":"fix","summary":"Looks wrong","findings":[]}', [
    change("lib/a.ts", "export const a = 1;\n"),
  ]);
  assert.equal(review?.verdict, "pass");
});

test("an answer that is not JSON is no review at all", () => {
  assert.equal(parseReview("I think this is fine.", [change("lib/a.ts", "x")]), null);
  assert.equal(parseReview('{"verdict":"maybe"}', [change("lib/a.ts", "x")]), null);
});

test("a reviewer finding alone can block, and the summary survives assembly", () => {
  const review = assembleReview({
    staticFindings: [],
    model: {
      verdict: "fix",
      summary: "The branch cache is never cleared.",
      findings: [{ path: "lib/a.ts", severity: "error", message: "the cache is never cleared" }],
    },
    repaired: true,
  });
  assert.equal(review.verdict, "fix");
  assert.equal(review.repaired, true);
  assert.equal(review.modelChecked, true);
  assert.ok(hasBlockingFinding(review.findings));
});

test("without a reviewer the summary states what was and was not checked", () => {
  const review = assembleReview({ staticFindings: [], model: null, repaired: false });
  assert.equal(review.verdict, "pass");
  assert.equal(review.modelChecked, false);
  assert.match(review.summary, /No build was run/);
  assert.equal(hasBlockingFinding(review.findings), false);
});

test("duplicate findings are collapsed, errors first", () => {
  const review = assembleReview({
    staticFindings: [
      { path: "lib/a.ts", severity: "warning", message: "look here" },
      { path: "lib/a.ts", severity: "warning", message: "look here" },
      { path: "lib/b.ts", severity: "error", message: "broken" },
    ],
    model: { verdict: "pass", summary: "ok", findings: [] },
    repaired: false,
  });
  assert.equal(review.findings.length, 2);
  assert.equal(review.findings[0]?.severity, "error");
});

test("the repair turn names the findings and does not describe the files", () => {
  const message = repairRequest(
    [{ path: "lib/a.ts", severity: "error", message: "one unclosed { at the end of the file" }],
    [change("lib/a.ts", "export const a = 1;\n")]
  );
  assert.equal(message.role, "user");
  assert.match(message.content ?? "", /lib\/a\.ts: one unclosed/);
  assert.match(message.content ?? "", /propose_edits/);
});

test("the reviewer is told it is not a build, and gets the diffs", () => {
  const messages = reviewMessages(
    [change("lib/a.ts", "export const a = 2;\n")],
    { repoFullName: "lowendlagani/openmi", baseSha: "a".repeat(40), branch: "main" },
    [{ path: "lib/a.ts", severity: "warning", message: "look here" }]
  );
  assert.equal(messages.length, 2);
  assert.match(messages[0]?.content ?? "", /cannot run the tests/);
  assert.match(messages[0]?.content ?? "", /JSON only/);
  assert.match(messages[1]?.content ?? "", /look here/);
  assert.match(messages[1]?.content ?? "", /lowendlagani\/openmi/);
  assert.match(messages[1]?.content ?? "", /FILE lib\/a\.ts/);
});
