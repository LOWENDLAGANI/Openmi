import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, rateLimitRefusal, verifyCaller } from "@/lib/serverControl";
import { resolveGithubLink } from "@/lib/github/store";
import { readProject } from "@/lib/projects";
import {
  directChangeSetFrom,
  isChangeSetId,
  readChangeSet,
  saveChangeSet,
  viewOf,
} from "@/lib/changesets";
import { directPush } from "@/lib/push";

// ── Push a change straight to the default branch ────────────────────────────
//
// The button on a change card, and the only place a reviewed change becomes a
// direct push. It exists as its own route rather than as a flag on the commit
// route so that "which endpoint can write to a default branch?" has one answer,
// and so the review endpoint keeps its unconditional refusal.
//
// The change is rebuilt, not relabelled. The reviewed change set's branch is
// derived from its own id and is inside the server's signature, so it cannot be
// edited into a direct one — `directChangeSetFrom` builds a new change set from
// the same files (and therefore the same content hash, so the bytes pushed are
// the bytes that were on screen), targeting the repository's default branch.
// The person pressing the button is the authorisation; the model has no route
// here and no way to press it.
//
// Everything after that is the same gate as the review path: the change set's
// signature and hash, the base commit still being the branch head, and a
// connection that is still allowed to push.

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
    return Response.json({ error: "Sign in to push a change." }, { status: 401 });
  }

  // The commit budget, not a new one: a direct push costs the same GitHub
  // requests as any other commit and creates history in the same way.
  const limit = await checkRateLimit(req, identity, "commits");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many push attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const { id } = await context.params;
  if (!isChangeSetId(id)) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }

  const changeSet = await readChangeSet(authorization, identity.uid, id);
  if (!changeSet) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }

  const project = await readProject(authorization, identity.uid, changeSet.projectId);
  if (!project || project.repoFullName !== changeSet.repoFullName) {
    return Response.json({ error: "That repository is no longer attached to this account." }, { status: 404 });
  }

  const link = await resolveGithubLink(req, authorization, identity.uid);
  if (!link) {
    return Response.json({ error: "Connect GitHub first.", detail: "not-connected" }, { status: 401 });
  }

  // A change that already went direct is pushed again as itself, which is what
  // makes a retry after a failure work: the first attempt left the change set
  // and no commit, and this is the same change, not a second one.
  const direct = changeSet.direct ? changeSet : directChangeSetFrom(changeSet, project);
  if (!direct) {
    return Response.json(
      { error: "This change cannot be pushed directly. Review it and commit it to a branch instead." },
      { status: 409 }
    );
  }

  if (!changeSet.direct) {
    const stored = await saveChangeSet(authorization, identity.uid, direct).catch(() => false);
    if (!stored) {
      return Response.json(
        { error: "The change could not be saved for a direct push. Check the `changesets` policies in the Supabase project." },
        { status: 503 }
      );
    }
  }

  const result = await directPush({
    authorization,
    uid: identity.uid,
    changeSet: direct,
    token: link.token,
    signal: req.signal,
  });

  if (!result.ok) {
    return Response.json(
      { error: result.error, detail: result.detail ?? null, baseSha: result.baseSha ?? null },
      { status: result.status }
    );
  }

  return Response.json(
    {
      commit: result.commit,
      changeSet: viewOf({ ...direct, status: "committed" }),
      warning: result.warning,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
