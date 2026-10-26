import { NextRequest } from "next/server";
import { checkRateLimit, verifyCaller, rateLimitRefusal } from "@/lib/serverControl";
import { GithubError } from "@/lib/github/client";
import { loadBlob, loadTree } from "@/lib/github/cache";
import { MAX_FILE_BYTES, filterTree, isSafeRelativePath } from "@/lib/github/tree";
import { resolveGithubLink } from "@/lib/github/store";
import { isProjectId, readProject } from "@/lib/projects";

// ── One file ────────────────────────────────────────────────────────────────
//
// The path is checked against the filtered tree, not just against a regex. That
// matters: a path can be perfectly well-formed and still not be a file the
// workspace is allowed to show — an ignored directory, a binary blob, a file
// outside the pinned commit. Resolving through the tree answers all three at
// once, and the model's own read_file goes through the same list.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to read a repository file." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "project-files");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many requests. Try again in ${limit.retryAfterSeconds}s.`);
  }

  const { id } = await context.params;
  if (!isProjectId(id)) {
    return Response.json({ error: "Unknown project." }, { status: 404 });
  }

  const path = req.nextUrl.searchParams.get("path") ?? "";
  if (!isSafeRelativePath(path)) {
    return Response.json({ error: "That path is not a file inside the repository." }, { status: 400 });
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
    const file = filtered.files.find((candidate) => candidate.path === path);
    if (!file) {
      return Response.json({ error: "That file is not part of this project's readable tree." }, { status: 404 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return Response.json(
        { error: `That file is ${Math.round(file.size / 1024)} KB, too large to open here.` },
        { status: 413 }
      );
    }

    const blob = await loadBlob(link.token, project.repoFullName, file.sha);
    if (!blob) {
      return Response.json({ error: "That file is binary or could not be decoded as text." }, { status: 415 });
    }

    return Response.json(
      { path: file.path, text: blob.text, truncated: blob.truncated, size: file.size },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GithubError) {
      const status = error.status === 401 ? 401 : error.status === 429 ? 429 : error.status === 404 ? 404 : 502;
      return Response.json({ error: error.message }, { status });
    }
    console.error("[projects] file failed", error);
    return Response.json({ error: "The file could not be read. Try again." }, { status: 502 });
  }
}
