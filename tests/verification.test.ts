// ── The pre-push checks ─────────────────────────────────────────────────────
//
// Two things are worth testing here, and they pull in opposite directions:
//
//   1. A finding has to be true. Every check below is asserted against a real
//      mistake, because a false finding refuses a correct change.
//   2. A check that cannot be sure has to say so instead of guessing. The
//      unresolved-import rule is the interesting one: it is an error when the
//      tree was read completely and a warning when it was not.
//
// The last group is a source contract: Openmi does not run anything yet, and
// the module that checks a change must not pretend that it does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describeReport, relativeSpecifiersIn, summarizeFindings, verifyStagedFiles } from "../lib/verify";

let failures = 0;
let passes = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

function read(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

const TREE = [
  "app/page.tsx",
  "lib/db.ts",
  "lib/format/index.ts",
  "src/ui/Button.tsx",
  "src/ui/index.ts",
  "package.json",
  "tsconfig.json",
  "public/logo.svg",
];

function file(filePath: string, after: string, kind: "modified" | "created" = "modified") {
  return { path: filePath, kind, after };
}

/** Codes of the errors a report holds, sorted, so a test reads as a contract. */
function errorCodes(report: ReturnType<typeof verifyStagedFiles>): string[] {
  return report.errors.map((finding) => finding.code).sort();
}

function warningCodes(report: ReturnType<typeof verifyStagedFiles>): string[] {
  return report.warnings.map((finding) => finding.code).sort();
}

(async () => {
  // ── A change that is fine ─────────────────────────────────────────────────

  await test("a well-formed change passes, against the whole tree", () => {
    const report = verifyStagedFiles({
      files: [
        file("app/login/page.tsx", 'import Button from "@/components/Button";\nimport { format } from "../../lib/format";\n', "created"),
        file("next.config.mjs", "export default {};\n"),
      ],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(report.errors, [], "nothing here is wrong");
    assert.deepEqual(report.warnings, []);
    assert.equal(report.ok, true);
  });

  await test("extension, index and compiled-name imports all resolve", () => {
    const report = verifyStagedFiles({
      files: [
        file(
          "src/ui/Card.tsx",
          [
            'import { Button } from "./Button";',
            'import { helpers } from "../../lib/format";',
            'import { db } from "../../lib/db.js";',
            'import { ui } from "./index";',
          ].join("\n")
        ),
      ],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), [], "every one of these points at a real file");
  });

  // ── Findings that have to be true ─────────────────────────────────────────

  await test("invalid JSON is an error, and a commented tsconfig is not", () => {
    // A trailing comma is the mistake this check exists to find, and it must be
    // found in a file that has to be strict JSON — not forgiven because
    // tsconfig.json is allowed to carry comments.
    const broken = verifyStagedFiles({
      files: [file("package.json", '{ "name": "openmi", }')],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(broken), ["bad-json"]);

    const truncated = verifyStagedFiles({
      files: [file("package.json", '{ "name": "openmi"')],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(truncated), ["bad-json"]);

    const commented = verifyStagedFiles({
      files: [
        file(
          "tsconfig.json",
          [
            "{",
            "  // TypeScript's own documentation writes tsconfigs like this",
            '  "compilerOptions": { "strict": true },',
            "}",
          ].join("\n")
        ),
      ],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(commented), [], "JSONC must not be reported as broken JSON");
  });

  await test("an empty source file is an error", () => {
    const report = verifyStagedFiles({
      files: [file("lib/login.ts", "   \n", "created")],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), ["empty-file"]);
  });

  await test("build output and lockfiles cannot be committed", () => {
    const report = verifyStagedFiles({
      files: [file("dist/app.js", "x();\n"), file("bun.lock", "{}\n"), file("node_modules/x/index.js", "x();\n")],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), ["path-ignored", "path-ignored", "path-ignored"]);
  });

  await test("a path that escapes the repository is an error", () => {
    const report = verifyStagedFiles({
      files: [file("../outside.ts", "export {};\n"), file("/etc/passwd", "root\n")],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), ["path-unsafe", "path-unsafe"]);
  });

  await test("a new file that already exists is an error", () => {
    const report = verifyStagedFiles({
      files: [file("lib/db.ts", "export const db = 1;\n", "created")],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), ["new-file-exists"]);
  });

  await test("binary content is an error", () => {
    const report = verifyStagedFiles({
      files: [file("public/logo.svg", "<svg>\u0000</svg>", "created")],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), ["binary"]);
  });

  // ── The import rule, and its honest limit ─────────────────────────────────

  await test("an import that resolves to nothing is an error when the tree is whole", () => {
    const report = verifyStagedFiles({
      files: [file("app/login/page.tsx", 'import { LoginForm } from "./LoginForm";\n', "created")],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), ["missing-import"]);
    assert.match(report.errors[0]!.message, /nothing at app\/login\/LoginForm exists/);
  });

  await test("the same import is only a warning when the tree could not be read", () => {
    for (const input of [
      { treePaths: null, treeComplete: false },
      { treePaths: TREE, treeComplete: false },
    ]) {
      const report = verifyStagedFiles({
        files: [file("app/login/page.tsx", 'import { LoginForm } from "./LoginForm";\n', "created")],
        ...input,
      });
      assert.deepEqual(errorCodes(report), [], "an unsure check must not refuse a change");
      assert.deepEqual(warningCodes(report), ["missing-import"]);
      assert.equal(report.ok, true);
    }
  });

  await test("an import that leaves the repository is a warning, whatever the tree says", () => {
    const report = verifyStagedFiles({
      files: [file("app/page.tsx", 'import { x } from "../../../etc/x";\n')],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(errorCodes(report), []);
    assert.deepEqual(warningCodes(report), ["import-outside"]);
  });

  await test("a package import is not treated as a relative path", () => {
    const report = verifyStagedFiles({
      files: [file("app/page.tsx", 'import React from "react";\nimport { z } from "@scope/pkg";\n')],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual([...errorCodes(report), ...warningCodes(report)], []);
    assert.deepEqual(relativeSpecifiersIn('import a from "react"; import b from "./b";'), ["./b"]);
  });

  // ── What the reader is told ───────────────────────────────────────────────

  await test("the report says it is static, in every case", () => {
    const report = verifyStagedFiles({ files: [file("lib/db.ts", "export const db = 1;\n")], treePaths: TREE, treeComplete: true });
    assert.equal(report.ok, true);
    assert.ok(
      report.notes.some((note) => /static: they read the bytes/i.test(note)),
      "the reader must not be left thinking a build ran"
    );
    assert.ok(report.notes.some((note) => /can still fail in CI/i.test(note)));
  });

  await test("findings read as sentences with the path in front", () => {
    const report = verifyStagedFiles({
      files: [file("package.json", "{ oops")],
      treePaths: TREE,
      treeComplete: true,
    });
    assert.deepEqual(summarizeFindings(report.errors), [
      "package.json: it is not valid JSON, so the change would break everything that reads it",
    ]);
    assert.match(describeReport(report), /^The change failed its own checks: package\.json: /);
    assert.match(
      describeReport(verifyStagedFiles({ files: [file("lib/db.ts", "export const db = 1;\n")], treePaths: TREE, treeComplete: true })),
      /^The change passed its checks\.$/
    );
  });

  await test("an empty change set is refused rather than reported as clean", () => {
    const report = verifyStagedFiles({ files: [], treePaths: TREE, treeComplete: true });
    assert.equal(report.ok, false);
    assert.deepEqual(errorCodes(report), ["nothing"]);
  });

  // ── Source contracts ──────────────────────────────────────────────────────

  await test("checking a change never executes it", () => {
    const source = read("lib/verify.ts");
    assert.doesNotMatch(source, /child_process|execSync|\bspawn\(|api\.github\.com|new Function|\beval\(/);
    assert.doesNotMatch(source, /\bfetch\(/, "no network");
    assert.doesNotMatch(source, /process\.env/, "no environment");
    assert.match(source, /export function verifyStagedFiles/);
    // Pure, and structurally so: the only thing it reaches for is the path
    // rules, which are pure themselves.
    assert.deepEqual(
      [...source.matchAll(/^import .*$/gm)].map((match) => match[0]),
      ['import { isIgnoredPath, isSafeRelativePath } from "./github/tree";']
    );
  });

  await test("a direct push is refused when the checks fail, before anything is written", () => {
    const push = read("lib/push.ts");
    assert.match(push, /verifyChangeSet\(/);
    assert.match(push, /detail: "verification"/);
    assert.match(push, /status: 422/);
    // The check has to happen before the approval is signed and before the
    // commit call, or it is a report rather than a gate.
    const verifyAt = push.indexOf("verifyChangeSet(");
    assert.ok(verifyAt > 0 && verifyAt < push.indexOf("signApproval("), "verify before anything is authorised");
    assert.ok(verifyAt < push.indexOf("commitChanges("), "verify before anything is written");
  });

  await test("the step route reports what it checked", () => {
    const step = read("app/api/agent/step/route.ts");
    assert.match(step, /verifyChangeSet\(/);
    assert.match(step, /verification,/);
    assert.match(read("lib/agentStream.ts"), /verification: VerificationSummary \| null/);
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})();
