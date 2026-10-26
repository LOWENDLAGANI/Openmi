import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { GithubError, getBranchHead, getRepo } from "@/lib/github/client";
import { resolveGithubLink } from "@/lib/github/store";
import { readProject } from "@/lib/projects";
import { commitChanges } from "@/lib/github/commit";
import {
  commitGate,
  commitResult,
  isChangeSetId,
  readApproval,
  readChangeSet,
  readCommit,
  saveCommit,
  setChangeSetStatus,
  type CommitRecord,
} from "@/lib/changesets";

// ── The only write to GitHub ────────────────────────────────────────────────
//
// Every other route in this app is a read. This one creates a branch, a commit
// and a pull request, and it does so only when all of the following hold:
//
//   1. The caller is verified, and the change set is in their own node.
//   2. The change set still carries the server's signature, and its files still
//      hash to what was approved. A rewritten row is refused, not committed.
//   3. A signed approval exists for exactly this change (see `commitGate`).
//   4. The default branch still points at the commit the change was based on.
//      A moved branch is refused with a re-diff, never merged blindly.
//   5. This connection may still push — re-checked here, not trusted from the
//      approve response.
//   6. A commit record does not already exist. A double submit returns the
//      first commit instead of making a second one, and the branch name is
//      derived from the change, so even a racing pair can only create one ref.
//
// The model has no route to this endpoint and no token to call it with: it has
// already answered by the time a proposal exists.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to commit a change." }, { status: 401 });
  }

  // Deliberately tight: a commit costs GitHub requests and creates history, and
  // nothing a person does legitimately needs more than a few per minute.
  const limit = await checkRateLimit(req, identity, "commits");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many commit attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const { id } = await context.params;
  if (!isChangeSetId(id)) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }

  const changeSet = await readChangeSet(authorization, identity.uid, id);
  if (!changeSet) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }

  const approval = await readApproval(authorization, identity.uid, id);
  const existing = await readCommit(authorization, identity.uid, id);

  const gate = commitGate({ changeSet, approval, existingCommit: existing });
  if (!gate.ok) {
    return Response.json({ error: gate.error, detail: gate.detail ?? null }, { status: gate.status });
  }
  if (gate.alreadyCommitted) {
    return Response.json(
      { commit: commitResult(gate.alreadyCommitted, true) },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const project = await readProject(authorization, identity.uid, changeSet.projectId);
  if (!project || project.repoFullName !== changeSet.repoFullName) {
    return Response.json({ error: "That repository is no longer attached to this account." }, { status: 404 });
  }

  const link = await resolveGithubLink(req, authorization, identity.uid);
  if (!link) {
    return Response.json({ error: "Connect GitHub first.", detail: "not-connected" }, { status: 401 });
  }

  try {
    // The invariant that matters most here: the change was computed against a
    // commit, and a commit onto a different parent is a different change. A
    // moved branch is refused, and the current head travels back so the review
    // screen can say which version the reviewer is now looking at.
    const head = await getBranchHead(link.token, changeSet.repoFullName, changeSet.defaultBranch);
    if (head !== changeSet.baseSha) {
      await setChangeSetStatus(authorization, identity.uid, changeSet, "stale").catch(() => false);
      return Response.json(
        {
          error: `${changeSet.defaultBranch} has moved since this change was proposed. Ask the agent to propose it against the current version.`,
          detail: "stale",
          baseSha: head,
        },
        { status: 409 }
      );
    }

    const repo = await getRepo(link.token, changeSet.repoFullName);
    if (!repo.permissions?.push) {
      return Response.json(
        { error: "This GitHub connection cannot push to that repository, so nothing was committed." },
        { status: 403 }
      );
    }

    const outcome = await commitChanges({
      token: link.token,
      repoFullName: changeSet.repoFullName,
      baseSha: changeSet.baseSha,
      branch: changeSet.branch,
      message: changeSet.message,
      files: changeSet.files.map((file) => ({ path: file.path, content: file.after })),
      defaultBranch: changeSet.defaultBranch,
      signal: req.signal,
    });

    const record: CommitRecord = {
      changeSetId: changeSet.id,
      sha: outcome.sha,
      branch: outcome.branch,
      // Empty, never null: the database stores no nulls, and "no pull request"
      // is a missing string rather than a missing field.
      prUrl: outcome.prUrl ?? "",
      at: Date.now(),
    };

    // The commit exists whether or not these two writes land. They are reported
    // as warnings instead of failing the request, because a 500 here would tell
    // the user nothing was committed while the branch says otherwise.
    const saved = await saveCommit(authorization, identity.uid, record);
    await setChangeSetStatus(authorization, identity.uid, changeSet, "committed").catch(() => false);

    return Response.json(
      {
        commit: commitResult(record, false),
        // Why a pull request is missing, when it is. A branch with no PR is a
        // real outcome, not a failure to hide.
        warning: outcome.prError,
        stored: saved,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GithubError) {
      const status =
        error.status === 401 ? 401 : error.status === 429 ? 429 : error.status === 404 ? 404 : error.status === 409 ? 409 : 502;
      return Response.json({ error: error.message, resetAt: error.resetAt ?? null }, { status });
    }
    console.error("[changesets] commit failed", error);
    return Response.json(
      { error: "The commit could not be completed. Nothing was pushed; check the repository before retrying." },
      { status: 502 }
    );
  }
}
