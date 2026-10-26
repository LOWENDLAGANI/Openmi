import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { GithubError, getBranchHead, getRepo } from "@/lib/github/client";
import { resolveGithubLink } from "@/lib/github/store";
import { readProject } from "@/lib/projects";
import {
  isChangeSetId,
  readChangeSet,
  saveApproval,
  setChangeSetStatus,
  signApproval,
  viewOf,
} from "@/lib/changesets";

// ── Approving a change ──────────────────────────────────────────────────────
//
// Approval is where the person, rather than the model, decides. Two checks
// happen here that no tool can perform:
//
//   1. The branch still points at the commit this change was computed against.
//      If somebody pushed in between, the diff is against a version that is no
//      longer the tip, and approving it would merge two histories by accident.
//      The change is marked stale and the reviewer has to ask again.
//   2. This connection may still push. Read access to a repository is not
//      permission to write to it, and the check is repeated at commit time
//      because permission can be withdrawn between the two.
//
// The record written here is an HMAC over the change's hash, base commit and
// branch. The commit endpoint requires it and cannot be given a forged one: the
// browser may write its own rows, but it does not hold the signing key.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    return Response.json({ error: "Sign in to approve a change." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "changeset-approve");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const { id } = await context.params;
  if (!isChangeSetId(id)) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }

  const changeSet = await readChangeSet(authorization, identity.uid, id);
  if (!changeSet) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }
  if (changeSet.status === "committed") {
    return Response.json(
      { error: "This change is already committed.", detail: "committed" },
      { status: 409 }
    );
  }
  if (changeSet.exp <= Date.now()) {
    return Response.json(
      { error: "This proposal has expired. Ask the agent to propose the change again.", detail: "expired" },
      { status: 409 }
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
        { error: "This GitHub connection cannot push to that repository, so the change cannot be committed." },
        { status: 403 }
      );
    }

    const approval = signApproval(changeSet);
    const saved = await saveApproval(authorization, identity.uid, approval);
    if (!saved) {
      return Response.json(
        { error: "The approval could not be recorded. Check the `approvals` policies in the Supabase project." },
        { status: 503 }
      );
    }
    await setChangeSetStatus(authorization, identity.uid, changeSet, "approved").catch(() => false);

    return Response.json(
      {
        changeSet: viewOf({ ...changeSet, status: "approved" }),
        approvedAt: approval.at,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GithubError) {
      const status = error.status === 401 ? 401 : error.status === 429 ? 429 : error.status === 404 ? 404 : 502;
      return Response.json({ error: error.message, resetAt: error.resetAt ?? null }, { status });
    }
    console.error("[changesets] approve failed", error);
    return Response.json({ error: "The change could not be approved. Try again." }, { status: 502 });
  }
}
