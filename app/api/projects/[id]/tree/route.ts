import { NextRequest } from "next/server";
import { checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { GithubError } from "@/lib/github/client";
import { loadTree } from "@/lib/github/cache";
import { filterTree } from "@/lib/github/tree";
import { resolveGithubLink } from "@/lib/github/store";
import { isProjectId, readProject } from "@/lib/projects";

// ── The file list for a project ──────────────────────────────────────────────
//
// The same filter the agent's list_files uses, so the tree the user browses and
// the tree the agent reasons about are the same repository. A pane that showed
// `node_modules` while the agent could not see it would be lying about what the
// agent knows.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to browse a repository." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 60, "projects");
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

  const link = await resolveGithubLink(req, authorization, identity.uid);
  if (!link) {
    return Response.json({ error: "Connect GitHub first.", detail: "not-connected" }, { status: 401 });
  }

  try {
    const tree = await loadTree(link.token, project.repoFullName, project.baseSha);
    const filtered = filterTree(tree.entries, tree.truncated);
    return Response.json(
      {
        project,
        files: filtered.files.map((file) => ({ path: file.path, size: file.size })),
        total: filtered.total,
        truncated: filtered.truncated,
        githubTruncated: filtered.githubTruncated,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GithubError) {
      const status = error.status === 401 ? 401 : error.status === 429 ? 429 : error.status === 404 ? 404 : 502;
      return Response.json({ error: error.message }, { status });
    }
    console.error("[projects] tree failed", error);
    return Response.json({ error: "The repository could not be read. Try again." }, { status: 502 });
  }
}
