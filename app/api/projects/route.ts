import { NextRequest } from "next/server";
import { isSameOriginRequest, checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { GithubError, getBranchHead, getRepo, normalizeRepoFullName } from "@/lib/github/client";
import { resolveGithubLink } from "@/lib/github/store";
import {
  listProjects,
  projectIdFor,
  readProject,
  saveProject,
  type ProjectSummary,
} from "@/lib/projects";

// ── Projects: a repository pinned at a commit ────────────────────────────────
//
// Attaching a repository is not just "remember this name". It records the
// commit the workspace is looking at, which is what every read is based on and
// what a change set will later be diffed against. Pinning it here means the
// file the agent read and the file the reviewer sees are the same version even
// if somebody pushes in between.
//
// Stored under `projects/{uid}` with the caller's own token: the rules decide
// who may write it, and the path itself scopes it to one account.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof GithubError) {
    const status = error.status === 401 ? 401 : error.status === 429 ? 429 : error.status === 404 ? 404 : 502;
    return Response.json({ error: error.message, resetAt: error.resetAt ?? null }, { status });
  }
  console.error("[projects] attach failed", error);
  return Response.json({ error: "The project could not be attached. Try again." }, { status: 502 });
}

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");

  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to see your projects." }, { status: 401 });
  }

  const projects = await listProjects(authorization, identity.uid);
  return Response.json({ projects }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in before attaching a repository." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 20, "projects");
  if (!limit.allowed) {
    return Response.json({ error: `Too many attempts. Try again in ${limit.retryAfterSeconds}s.` }, { status: 429 });
  }

  let body: { repoFullName?: unknown };
  try {
    body = (await req.json()) as { repoFullName?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fullName = normalizeRepoFullName(body.repoFullName);
  if (!fullName) {
    return Response.json({ error: "Give a repository as `owner/name`." }, { status: 400 });
  }

  const link = await resolveGithubLink(req, authorization, identity.uid);
  if (!link) {
    return Response.json({ error: "Connect GitHub first.", detail: "not-connected" }, { status: 401 });
  }

  try {
    // Reading the repository both proves access and supplies the default
    // branch. The head of that branch is the commit the project is pinned at.
    const repo = await getRepo(link.token, fullName);
    const baseSha = await getBranchHead(link.token, fullName, repo.default_branch || "main");
    const now = Date.now();
    const id = projectIdFor(repo.full_name);

    const previous = await readProject(authorization, identity.uid, id);

    const project: ProjectSummary = {
      id,
      repoFullName: repo.full_name,
      defaultBranch: repo.default_branch || "main",
      baseSha,
      canPush: Boolean(repo.permissions?.push),
      addedAt: previous?.addedAt ?? now,
      updatedAt: now,
    };

    const saved = await saveProject(authorization, identity.uid, project);
    if (!saved) {
      return Response.json(
        { error: "The project could not be saved. Check the database rules for `projects/{uid}`." },
        { status: 503 }
      );
    }

    return Response.json({ project }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}
