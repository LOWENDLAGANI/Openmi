// ── A direct push: the one path that skips the pull request ──────────────────
//
// The review path commits to `agent/<slug>` and opens a pull request, so a
// human approves a diff before anything reaches a shared branch. This is the
// other path, and it is narrower on purpose:
//
//   - It runs only from two places, and both of them are a person's own
//     decision: the agent step route, when the person's message asked for a
//     direct push (lib/pushIntent.ts reads that), and the push endpoint, when
//     they pressed **Push to `<branch>`** on a change card.
//   - The model has no route here. There is no tool that reaches this file, and
//     no argument a model produces is read for the branch name.
//   - The branch is the repository's own default branch, taken from the project
//     row. It is never a string from the request.
//
// Everything else is the same gate as the review path, and deliberately so:
// the change set must still verify against its signature, the base commit must
// still be the branch head, and the connection must still be allowed to push.
// The only thing this path changes is the destination and the absence of a
// pull request.

import { GithubError, getBranchHead, getRepo } from "./github/client";
import { commitChanges } from "./github/commit";
import {
  commitResult,
  readCommit,
  saveApproval,
  saveCommit,
  setChangeSetStatus,
  signApproval,
  type ChangeSet,
  type CommitRecord,
} from "./changesets";
import type { CommitResult } from "./types";

export interface DirectPushInput {
  authorization: string | null;
  uid: string;
  /** The signed change set, already verified against its own hash. */
  changeSet: ChangeSet;
  /** The caller's GitHub token, already opened from their sealed record. */
  token: string;
  signal?: AbortSignal;
}

export type DirectPushResult =
  | { ok: true; commit: CommitResult; warning: string | null }
  | { ok: false; status: number; error: string; detail?: string; baseSha?: string };

/**
 * Commits a direct change set to the repository's default branch.
 *
 * The approval is signed here rather than by the approve endpoint, because on
 * this path there is no second decision to record: the person's own request
 * *is* the authorisation, and it is what caused this change set to be built in
 * direct mode in the first place (see `buildChangeSet`'s `target`). A change
 * set built for review can never be promoted to a direct push by editing a row
 * — the `direct` flag is inside the signature.
 */
export async function directPush(input: DirectPushInput): Promise<DirectPushResult> {
  const { authorization, uid, changeSet, token } = input;

  if (!changeSet.direct) {
    return {
      ok: false,
      status: 403,
      error: "This change was proposed for review, not for a direct push.",
      detail: "not-direct",
    };
  }
  if (changeSet.status === "committed") {
    const existing = await readCommit(authorization, uid, changeSet.id);
    if (existing) return { ok: true, commit: commitResult(existing, true), warning: null };
    return {
      ok: false,
      status: 409,
      error: "This change set is already committed, but its commit record could not be read.",
      detail: "committed",
    };
  }

  try {
    // The same two checks the review path makes, for the same reasons. A branch
    // that moved under the change means the diff is against a version that is
    // no longer the tip; a connection that cannot push cannot push.
    const head = await getBranchHead(token, changeSet.repoFullName, changeSet.defaultBranch);
    if (head !== changeSet.baseSha) {
      await setChangeSetStatus(authorization, uid, changeSet, "stale").catch(() => false);
      return {
        ok: false,
        status: 409,
        error: `${changeSet.defaultBranch} has moved since this change was proposed. Ask the agent to propose it against the current version.`,
        detail: "stale",
        baseSha: head,
      };
    }

    const repo = await getRepo(token, changeSet.repoFullName);
    if (!repo.permissions?.push) {
      return {
        ok: false,
        status: 403,
        error: "This GitHub connection cannot push to that repository, so nothing was committed.",
      };
    }

    const approval = signApproval(changeSet);
    const recorded = await saveApproval(authorization, uid, approval).catch(() => false);
    if (!recorded) {
      return {
        ok: false,
        status: 503,
        error: "The approval could not be recorded. Check the `approvals` policies in the Supabase project.",
      };
    }

    const outcome = await commitChanges({
      token,
      repoFullName: changeSet.repoFullName,
      // The parent is the change's own base commit, which the check above has
      // just proved is the branch head. A direct push is therefore always a
      // fast-forward: it adds one commit and rewrites nothing.
      baseSha: changeSet.baseSha,
      branch: changeSet.branch,
      message: changeSet.message,
      files: changeSet.files.map((file) => ({ path: file.path, content: file.after })),
      defaultBranch: changeSet.defaultBranch,
      // The only place either of these is true, and the write module refuses a
      // default branch without both.
      allowDefaultBranch: true,
      // No pull request: the branch *is* the default branch, and GitHub refuses
      // a pull request whose head and base are the same.
      openPullRequest: false,
      signal: input.signal,
    });

    const record: CommitRecord = {
      changeSetId: changeSet.id,
      sha: outcome.sha,
      branch: outcome.branch,
      prUrl: outcome.prUrl ?? "",
      direct: true,
      at: Date.now(),
    };

    await saveCommit(authorization, uid, record).catch(() => false);
    await setChangeSetStatus(authorization, uid, changeSet, "committed").catch(() => false);

    return { ok: true, commit: commitResult(record, false), warning: outcome.prError };
  } catch (error) {
    if (error instanceof GithubError) {
      const status =
        error.status === 401 ? 401 : error.status === 429 ? 429 : error.status === 404 ? 404 : error.status === 409 ? 409 : 502;
      return { ok: false, status, error: error.message };
    }
    console.error("[push] direct push failed", error);
    return {
      ok: false,
      status: 502,
      error: "The push could not be completed. Nothing was pushed; check the repository before retrying.",
    };
  }
}
