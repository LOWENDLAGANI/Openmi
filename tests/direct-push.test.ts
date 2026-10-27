// ── The direct push, end to end in the parts that can be tested ──────────────
//
// The feature is: a person says "build me a login and push it to main when
// you're done", and the change goes to their default branch with no pull
// request. Three things have to hold for that to be safe, and each has its own
// group below:
//
//   1. Only the human's own sentence asks for it (lib/pushIntent.ts). A model
//      cannot set it and neither can a file in the repository.
//   2. The destination is decided by the server, and it is inside the signature
//      (lib/changesets.ts). A change proposed for review cannot be relabelled
//      as a direct push by editing a row, and a direct change can only name the
//      repository's default branch.
//   3. The write module refuses a default branch unless it was asked for
//      (lib/github/commit.ts), and exactly one module ever asks.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  branchFor,
  buildChangeSet,
  commitGate,
  directChangeSetFrom,
  isDirectBranchName,
  normalizeApproval,
  normalizeChangeSet,
  signApproval,
  viewOf,
  type ChangeSet,
} from "../lib/changesets";
import { detectDirectPushRequest } from "../lib/pushIntent";

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

const BASE_SHA = "a".repeat(40);
const AFTER = "export const DEW = 0.25;\n";
const DIFF = [
  "--- a/src/lib/dew.ts",
  "+++ b/src/lib/dew.ts",
  "@@ -1 +1 @@",
  "-export const DEW = 0.5;",
  `+${AFTER.trim()}`,
].join("\n");

const project = { id: "0123456789ab", repoFullName: "owner/repo", defaultBranch: "main", baseSha: BASE_SHA };

function proposal() {
  return {
    path: "src/lib/dew.ts",
    kind: "modified" as const,
    added: 1,
    removed: 1,
    diff: DIFF,
    after: AFTER,
    bytes: Buffer.byteLength(AFTER, "utf8"),
  };
}

function reviewChangeSet(now = Date.now()): ChangeSet {
  const changeSet = buildChangeSet({ project, proposals: [proposal()], now });
  assert.ok(changeSet, "a proposal must build a change set");
  return changeSet;
}

function directChangeSet(now = Date.now()): ChangeSet {
  const changeSet = buildChangeSet({ project, proposals: [proposal()], target: "default", now });
  assert.ok(changeSet, "a direct proposal must build a change set");
  return changeSet;
}

(async () => {
  // ── 1. The person's own sentence ──────────────────────────────────────────

  await test("a message that asks for the finished change to be pushed", () => {
    for (const text of [
      "Build me a login and after finish push to main GitHub",
      "Build me a login and push it to main when you're done",
      "add a settings page and commit it to github",
      "fix this bug and push when you're done",
      "make the navbar sticky and push automatically",
      "write the tests, then push it to the default branch",
    ]) {
      assert.ok(detectDirectPushRequest(text), `"${text}" reads as a direct-push request`);
    }
  });

  await test("a question, a refusal or an explanation is not an instruction", () => {
    for (const text of [
      "how do I push to main?",
      "don't push this to main",
      "do not commit to main, open a pull request instead",
      "explain the push to main flow",
      "if I push to main, what happens",
      "what does pushing to main do",
      "I need to understand whether to commit to main",
      "build a login page",
      "",
    ]) {
      assert.equal(detectDirectPushRequest(text), null, `"${text}" must not ask for a direct push`);
    }
  });

  // ── 2. Where the change goes, decided by the server ───────────────────────

  await test("review goes to its own branch, direct goes to the default branch", () => {
    const review = reviewChangeSet();
    assert.equal(review.direct, false);
    assert.equal(review.branch, branchFor("owner/repo", review.id));
    assert.match(review.branch, /^agent\//);
    assert.equal(review.defaultBranch, "main");

    const direct = directChangeSet();
    assert.equal(direct.direct, true);
    assert.equal(direct.branch, "main");
    // Same files, so the same hash: what a direct push commits is exactly the
    // bytes the review card showed.
    assert.equal(direct.hash, review.hash);
    assert.equal(direct.baseSha, review.baseSha);
  });

  await test("a direct change set round-trips through the database's JSON", () => {
    const direct = directChangeSet();
    assert.deepEqual(normalizeChangeSet(JSON.parse(JSON.stringify(direct))), direct);
  });

  await test("a stored change cannot be relabelled as a direct push", () => {
    // The signature, not the shape check, is what refuses this: the payload
    // includes `direct` and the branch, so the digest stops matching.
    const row = JSON.parse(JSON.stringify(reviewChangeSet())) as ChangeSet;
    row.direct = true;
    row.branch = "main";
    assert.equal(normalizeChangeSet(row), null, "a relabelled change must not verify");

    // And the flag cannot be dropped either, so a direct change cannot be made
    // to look like a review one.
    const dropped = JSON.parse(JSON.stringify(directChangeSet())) as Partial<ChangeSet>;
    delete dropped.direct;
    assert.equal(normalizeChangeSet(dropped), null);
  });

  await test("a direct change may only name the repository's default branch", () => {
    const elsewhere = JSON.parse(JSON.stringify(directChangeSet())) as ChangeSet;
    elsewhere.branch = "release";
    assert.equal(normalizeChangeSet(elsewhere), null, "a direct change to another branch must not verify");

    const ours = JSON.parse(JSON.stringify(directChangeSet())) as ChangeSet;
    ours.branch = "agent/repo-abc123";
    assert.equal(normalizeChangeSet(ours), null, "a direct change cannot name an agent branch");
  });

  await test("a direct destination has to be a real branch name and never one of ours", () => {
    for (const name of ["main", "master", "release/2.0", "trunk"]) {
      assert.equal(isDirectBranchName(name), true, `${name} should be usable`);
    }
    for (const name of ["agent/repo-abc123", "", "feature/../etc", "a//b", "refs/heads/main.lock", "a\\b", "x y"]) {
      assert.equal(isDirectBranchName(name), false, `${name} must not be usable`);
    }
  });

  // ── 3. The gate, and which endpoint may open it ───────────────────────────

  await test("the review endpoint refuses a direct change; the push path may take it", () => {
    const approved: ChangeSet = { ...directChangeSet(), status: "approved" };
    const approval = signApproval(approved);

    const refused = commitGate({ changeSet: approved, approval, existingCommit: null });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok ? "" : refused.detail, "direct-not-allowed");

    const allowed = commitGate({ changeSet: approved, approval, existingCommit: null, allowDirect: true });
    assert.equal(allowed.ok, true, "a signed direct change with a matching approval may be pushed");
  });

  await test("allowing a direct push loosens nothing else", () => {
    const approved: ChangeSet = { ...directChangeSet(), status: "approved" };
    const approval = signApproval(approved);

    const noApproval = commitGate({ changeSet: approved, approval: null, existingCommit: null, allowDirect: true });
    assert.equal(noApproval.ok, false);
    assert.equal(noApproval.ok ? "" : noApproval.detail, "no-approval");

    const wrongBranch: ChangeSet = { ...approved, branch: "release" };
    const branch = commitGate({
      changeSet: wrongBranch,
      approval: signApproval(wrongBranch),
      existingCommit: null,
      allowDirect: true,
    });
    assert.equal(branch.ok, false);
    assert.equal(branch.ok ? "" : branch.detail, "branch");

    const expired: ChangeSet = { ...approved, exp: Date.now() - 1 };
    const late = commitGate({ changeSet: expired, approval, existingCommit: null, allowDirect: true });
    assert.equal(late.ok, false);
    assert.equal(late.ok ? "" : late.detail, "expired");
  });

  await test("the review path behaves exactly as it did", () => {
    const review = reviewChangeSet();
    const unapproved = commitGate({ changeSet: review, approval: null, existingCommit: null });
    assert.equal(unapproved.ok, false);
    assert.equal(unapproved.ok ? "" : unapproved.detail, "not-approved");

    const approved: ChangeSet = { ...review, status: "approved" };
    const ok = commitGate({ changeSet: approved, approval: signApproval(approved), existingCommit: null });
    assert.equal(ok.ok, true);
  });

  await test("a reviewed change becomes a direct one with the same bytes", () => {
    const review = reviewChangeSet();
    const direct = directChangeSetFrom(review, project);
    assert.ok(direct);
    assert.equal(direct.direct, true);
    assert.equal(direct.branch, "main");
    assert.equal(direct.hash, review.hash, "the pushed bytes are the bytes that were read");
    assert.equal(direct.baseSha, review.baseSha, "it stays against the commit the diff was computed from");

    assert.equal(directChangeSetFrom(direct, project), null, "a direct change is not rebuilt as one");
    assert.equal(
      directChangeSetFrom(review, { ...project, repoFullName: "other/repo" }),
      null,
      "a change cannot be moved into another repository"
    );
  });

  await test("an approval for a direct push still verifies", () => {
    const direct = directChangeSet();
    const approval = signApproval(direct);
    assert.equal(approval.branch, "main");
    assert.deepEqual(normalizeApproval(JSON.parse(JSON.stringify(approval))), approval);
  });

  await test("the review card is told which path the change will take", () => {
    const review = viewOf(reviewChangeSet());
    assert.equal(review.direct, false);
    assert.equal(review.defaultBranch, "main");
    assert.equal(viewOf(directChangeSet()).direct, true);
  });

  // ── 4. Source contracts: one writer, one way in ───────────────────────────

  await test("the write module still names the branch it may write, and now names the exception", () => {
    const commit = read("lib/github/commit.ts");
    assert.match(commit, /\^agent\\\//, "the agent/ policy is still enforced where it matters");
    assert.match(commit, /allowDefaultBranch/);
    assert.match(commit, /branch !== input\.defaultBranch/, "a direct push may only name the default branch");
    // The read client stays read-only.
    assert.doesNotMatch(read("lib/github/client.ts"), /method:\s*["'`](POST|PUT|PATCH|DELETE)/i);
  });

  await test("exactly one module can push to a default branch", () => {
    const push = read("lib/push.ts");
    assert.match(push, /allowDefaultBranch: true/);
    assert.match(push, /openPullRequest: false/, "a pull request whose head is the base is not a pull request");
    assert.match(push, /if \(!changeSet\.direct\)/, "a change proposed for review cannot be pushed directly");

    assert.doesNotMatch(
      read("app/api/changesets/[id]/commit/route.ts"),
      /allowDefaultBranch/,
      "the review endpoint cannot reach a default branch"
    );
    assert.doesNotMatch(read("app/api/changesets/[id]/approve/route.ts"), /commitChanges|allowDefaultBranch/);
    assert.doesNotMatch(read("lib/agent/tools.ts"), /directPush|allowDefaultBranch/, "no tool can reach the direct push");
    assert.doesNotMatch(read("lib/systemPrompt.ts"), /directPush/);
  });

  await test("the destination comes from the composer, never from the model or the repository", () => {
    const step = read("app/api/agent/step/route.ts");
    assert.match(step, /const wantsDirectPush = body\.directPush === true/);
    assert.match(step, /target: wantsDirectPush \? "default" : "review"/);
    assert.match(step, /await directPush\(/);
    // It still contains no GitHub write of its own; the pushing lives in lib/push.ts.
    assert.doesNotMatch(step, /git\/blobs|git\/trees|git\/commits|git\/refs|\/pulls/);

    const pushRoute = read("app/api/changesets/[id]/push/route.ts");
    assert.match(pushRoute, /isSameOriginRequest/);
    assert.match(pushRoute, /verifyCaller/);
    assert.match(pushRoute, /checkRateLimit\(req, identity, "commits"\)/);
    assert.match(pushRoute, /resolveGithubLink\(/, "the OAuth cookie connection has to work here too");
    assert.match(pushRoute, /readProject\(/);
    assert.match(pushRoute, /directChangeSetFrom\(/);
    assert.match(pushRoute, /directPush\(/);
    assert.doesNotMatch(pushRoute, /git\/blobs|git\/trees|git\/commits|git\/refs|\/pulls/);
  });

  await test("the browser sends the request, and the card offers the button", () => {
    const page = read("app/page.tsx");
    assert.match(page, /detectDirectPushRequest\(text\)/);
    assert.match(
      page,
      /JSON\.stringify\(\{ projectId: project\.id, history, transcript, turnToken, directPush \}\)/,
      "the step request must carry the decision"
    );

    const card = read("components/ChangeReview.tsx");
    assert.match(card, /\/api\/changesets\/\$\{changesetId\}\/push/);
    assert.match(card, /Push to /);
  });

  await test("the direct flag is recorded on both the change and the commit", () => {
    const sql = read("supabase/migrations/20261029000000_direct_push.sql");
    for (const table of ["changesets", "commits"]) {
      assert.match(
        sql,
        new RegExp(`alter table public\\.${table}\\s+add column if not exists direct boolean not null default false;`),
        `${table} must record which path the change took`
      );
    }
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})();
