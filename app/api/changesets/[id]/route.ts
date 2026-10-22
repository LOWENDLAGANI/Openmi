import { NextRequest } from "next/server";
import { checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { commitResult, isChangeSetId, readChangeSet, readCommit, viewOf } from "@/lib/changesets";

// ── One change set, for the review screen ────────────────────────────────────
//
// The diffs come from here, not from the step response that is rendered while
// the answer streams: a review screen that survives a reload has to be able to
// ask for the change it is reviewing, and a diff that is re-fetched is the diff
// the server holds rather than one assembled in the browser.
//
// Ownership is the database path, judged by the caller's own token. Another
// account's id resolves to nothing, which is also the answer for an id that
// never existed — the two are deliberately indistinguishable.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to review a change." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 120, "changesets");
  if (!limit.allowed) {
    return Response.json({ error: `Too many requests. Try again in ${limit.retryAfterSeconds}s.` }, { status: 429 });
  }

  const { id } = await context.params;
  if (!isChangeSetId(id)) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }

  const changeSet = await readChangeSet(authorization, identity.uid, id);
  if (!changeSet) {
    return Response.json({ error: "That change is not attached to this account." }, { status: 404 });
  }

  // A committed change is read for its result as much as its diff, so the
  // review card can still show where the commit went after a reload.
  const commit = await readCommit(authorization, identity.uid, id);

  return Response.json(
    {
      changeSet: viewOf(changeSet),
      commit: commit ? commitResult(commit, true) : null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
