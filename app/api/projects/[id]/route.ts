import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, verifyCaller } from "@/lib/serverControl";
import { deleteAsCaller } from "@/lib/rtdb";
import { isProjectId, readProject } from "@/lib/projects";

// ── Detaching a project ─────────────────────────────────────────────────────
//
// This forgets the workspace; it does not touch the repository. The GitHub
// connection is separate and survives, which is why the interface can offer
// "remove from list" without scaring anybody about their code.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authorization = req.headers.get("authorization");

  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to remove a project." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 20, "projects");
  if (!limit.allowed) {
    return Response.json({ error: `Too many requests. Try again in ${limit.retryAfterSeconds}s.` }, { status: 429 });
  }

  const { id } = await context.params;
  if (!isProjectId(id)) {
    return Response.json({ error: "Unknown project." }, { status: 404 });
  }

  const project = await readProject(authorization, identity.uid, id);
  if (!project) {
    return Response.json({ error: "That project is not attached to this account." }, { status: 404 });
  }

  const removed = await deleteAsCaller(authorization, `projects/${identity.uid}/${id}`);
  if (!removed) {
    return Response.json({ error: "The project could not be removed." }, { status: 503 });
  }

  return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
}
