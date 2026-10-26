import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { isConnectionId } from "@/lib/github/pat";
import {
  deleteGithubConnection,
  readGithubConnection,
  renameGithubConnection,
  setDefaultConnection,
} from "@/lib/github/connections";

// ── One connection ──────────────────────────────────────────────────────────
//
// Rename it, make it the default, or remove it. Projects are deliberately left
// alone by a removal: a project is a pointer to a repository, not a credential,
// and deleting it would throw away the person's place in a repository for a
// problem that is only about access. The next read reports that no connection
// can reach it, which is the truthful description.
//
// Every action is scoped to the verified uid. An id that belongs to somebody
// else answers the same as an id that does not exist — 404 either way — so a
// probe cannot discover which ids are real.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  label?: unknown;
  makeDefault?: unknown;
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json(
      { error: "This request did not come from Openmi.", detail: "cross-origin" },
      { status: 403 }
    );
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to change a GitHub connection." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "github-manage");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const { id } = await context.params;
  if (!isConnectionId(id)) {
    return Response.json({ error: "Unknown connection." }, { status: 404 });
  }

  const existing = await readGithubConnection(authorization, identity.uid, id);
  if (!existing) {
    return Response.json({ error: "Unknown connection." }, { status: 404 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.makeDefault === true) {
    const promoted = await setDefaultConnection(authorization, identity.uid, id);
    if (!promoted) {
      return Response.json(
        { error: "The default could not be changed. Check the `github_default` row in the Supabase project." },
        { status: 503 }
      );
    }
  }

  if (typeof body.label === "string") {
    const renamed = await renameGithubConnection(authorization, identity.uid, id, body.label);
    if (!renamed) {
      return Response.json({ error: "The label could not be saved." }, { status: 503 });
    }
    return Response.json(
      { connection: renamed, default: body.makeDefault === true },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return Response.json(
    { default: body.makeDefault === true },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json(
      { error: "This request did not come from Openmi.", detail: "cross-origin" },
      { status: 403 }
    );
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to remove a GitHub connection." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "github-manage");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many attempts. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const { id } = await context.params;
  if (!isConnectionId(id)) {
    return Response.json({ error: "Unknown connection." }, { status: 404 });
  }

  const removed = await deleteGithubConnection(authorization, identity.uid, id);
  if (!removed) {
    return Response.json({ error: "Unknown connection." }, { status: 404 });
  }

  return Response.json(
    { removed: true, id },
    { headers: { "Cache-Control": "no-store" } }
  );
}
