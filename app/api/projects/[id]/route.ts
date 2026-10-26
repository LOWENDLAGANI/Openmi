import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { clientForToken } from "@/lib/supabase";
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

  const limit = await checkRateLimit(req, identity, "projects");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many requests. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const { id } = await context.params;
  if (!isProjectId(id)) {
    return Response.json({ error: "Unknown project." }, { status: 404 });
  }

  const project = await readProject(authorization, identity.uid, id);
  if (!project) {
    return Response.json({ error: "That project is not attached to this account." }, { status: 404 });
  }

  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = token ? clientForToken(token) : null;
  let removed = false;
  if (client) {
    try {
      const { error } = await client
        .from("projects")
        .delete()
        .eq("owner", identity.uid)
        .eq("id", id);
      removed = !error;
    } catch {
      removed = false;
    }
  }
  if (!removed) {
    return Response.json({ error: "The project could not be removed." }, { status: 503 });
  }

  return Response.json({ removed: true }, { headers: { "Cache-Control": "no-store" } });
}
