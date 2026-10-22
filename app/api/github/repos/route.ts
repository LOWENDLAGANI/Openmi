import { NextRequest } from "next/server";
import { checkRateLimit, verifyCaller } from "@/lib/serverControl";
import { GithubError, listRepos } from "@/lib/github/client";
import { readGithubLink } from "@/lib/github/store";

// ── The repositories this connection can see ─────────────────────────────────
//
// One page of a hundred, newest first. Pagination is deliberately not exposed
// yet: the picker has a search field over what it was given, and adding pages
// before anyone has a hundred repositories would be a control with nothing
// behind it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown): Response {
  if (error instanceof GithubError) {
    const status = error.status === 0 ? 502 : error.status === 404 ? 404 : error.status === 429 ? 429 : error.status === 401 ? 401 : 502;
    return Response.json({ error: error.message, resetAt: error.resetAt ?? null }, { status });
  }
  console.error("[github] listing repositories failed", error);
  return Response.json({ error: "GitHub could not be reached. Try again shortly." }, { status: 502 });
}

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to list your repositories." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, 30, "github");
  if (!limit.allowed) {
    return Response.json({ error: `Too many requests. Try again in ${limit.retryAfterSeconds}s.` }, { status: 429 });
  }

  const link = await readGithubLink(authorization, identity.uid);
  if (!link) {
    return Response.json(
      { error: "Connect GitHub first.", detail: "not-connected" },
      { status: 401 }
    );
  }

  try {
    const repos = await listRepos(link.token);
    return Response.json(
      {
        login: link.login,
        repos: repos.map((repo) => ({
          fullName: repo.full_name,
          name: repo.name,
          private: repo.private,
          defaultBranch: repo.default_branch,
          canPush: Boolean(repo.permissions?.push),
          updatedAt: repo.updated_at ?? null,
        })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return failure(error);
  }
}
