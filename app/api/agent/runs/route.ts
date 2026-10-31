import { randomUUID } from "node:crypto";
import { NextRequest, after } from "next/server";
import {
  checkRateLimit,
  identityGate,
  isAdmin,
  isSameOriginRequest,
  rateLimitRefusal,
  readConfig,
  verifyCaller,
} from "@/lib/serverControl";
import { readProject, refreshProjectHead } from "@/lib/projects";
import { readUserKeys } from "@/lib/providerKeys";
import { resolveGithubLink } from "@/lib/github/store";
import { hourModelRefusal, hourRepoRefusal, readHourSession } from "@/lib/hourSession";
import { outOfDewMessage } from "@/lib/dew";
import { activeRunFor, createRun, runStartFailure, type AgentRunState } from "@/lib/agentRuns";
import { runStoreConfigured } from "@/lib/supabaseAdmin";
import { dispatchTick, internalOrigin, signTick } from "@/lib/agentRunToken";
import { cleanHistory } from "@/lib/agent/transcript";

// ── Start a repository turn that does not need the tab ───────────────────────
//
// Everything that needs the person is decided here, once: who they are, whether
// their hour covers this repository, which GitHub connection to read with, and
// which provider keys to prefer. The answer is sealed into the run, so the ticks
// that follow have no reason to look at a session at all.
//
// This route only *starts* work. The work happens in `/api/agent/tick`, which is
// authorised by a signed claim rather than by the caller above, so a run keeps
// going when the browser that asked for it is closed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** One turn's attached text may not exceed this, matching the step route. */
const MAX_ATTACHMENT_CHARS = 12_000;
/** The most conversation a run may carry in. */
const MAX_HISTORY_MESSAGES = 12;

interface StartBody {
  projectId?: unknown;
  history?: unknown;
  context?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");

  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to use the repository agent." }, { status: 401 });
  }

  const config = await readConfig();
  if (config.maintenanceEnabled && !isAdmin(identity)) {
    return Response.json({ error: config.maintenanceMessage }, { status: 503 });
  }
  if (!config.chatEnabled) {
    return Response.json({ error: "Openmi is paused right now. Please try again shortly." }, { status: 503 });
  }

  const limit = await checkRateLimit(req, identity, "agent");
  if (!limit.allowed) {
    return rateLimitRefusal(
      limit,
      `Too many agent steps at once. Please wait ${limit.retryAfterSeconds}s and try again.`
    );
  }
  const gate = identityGate(identity, config, config.dailyChatCap);
  if (!gate.allowed) {
    return Response.json({ error: gate.error ?? "Openmi is not available to this device." }, { status: 403 });
  }

  // A run without the privileged store would be created and never advanced, so
  // the refusal is here rather than after the person has waited for an answer.
  if (!runStoreConfigured()) {
    return Response.json(
      {
        error:
          "Background runs are not configured on this deployment. Add SUPABASE_SERVICE_ROLE_KEY, or keep the tab open — the agent still works while this page is.",
        detail: "runs-unconfigured",
      },
      { status: 503 }
    );
  }

  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return Response.json({ error: "A project is required." }, { status: 400 });

  const history = cleanHistory(body.history).slice(-MAX_HISTORY_MESSAGES);
  if (history.length === 0) {
    return Response.json({ error: "A conversation is required." }, { status: 400 });
  }
  const context = typeof body.context === "string" ? body.context.slice(0, MAX_ATTACHMENT_CHARS) : "";

  let project = await readProject(authorization, identity.uid, projectId);
  if (!project) {
    return Response.json({ error: "That project is not attached to this account." }, { status: 404 });
  }

  const link = await resolveGithubLink(req, authorization, identity.uid);
  if (!link) {
    return Response.json(
      { error: "Connect GitHub again to continue.", detail: "not-connected" },
      { status: 401 }
    );
  }

  // The branch is re-read before the run starts for the same reason the step
  // route does it: a proposal must be computed against the commit that is the
  // tip now, not the one that was the tip when the repository was attached.
  project = await refreshProjectHead(authorization, identity.uid, project, link.token);

  // ── The hour ───────────────────────────────────────────────────────────────
  // Checked here and only here. The ticks run long after this request, so the
  // purchase is verified once, at the moment the work is asked for — which is
  // the same moment it would be charged.
  const isCallerAdmin = isAdmin(identity);
  if (!isCallerAdmin) {
    const session = await readHourSession(authorization, identity.uid);
    if (!session) return Response.json({ error: outOfDewMessage() }, { status: 402 });
    if (session.model !== "code") {
      return Response.json({ error: hourModelRefusal(session, "code"), code: "session-model-locked" }, { status: 409 });
    }
    if (session.projectId !== project.id) {
      return Response.json(
        {
          error: hourRepoRefusal(session, project.repoFullName),
          code: "session-repo-locked",
        },
        { status: 409 }
      );
    }
  }

  // One live run per repository. A second would be a second budget spent on the
  // same question, and the chat attaches to the running one instead.
  const existing = await activeRunFor(authorization, identity.uid, project.id);
  if (existing) return Response.json({ run: existing }, { status: 200 });

  const accountKeys = await readUserKeys(authorization, identity.uid);

  const state: AgentRunState = {
    v: 1,
    uid: identity.uid,
    project: {
      id: project.id,
      repoFullName: project.repoFullName,
      defaultBranch: project.defaultBranch,
      baseSha: project.baseSha,
    },
    githubToken: link.token,
    accountKeys: Object.fromEntries(
      Object.entries(accountKeys).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    ),
    history,
    transcript: [],
    context,
    content: "",
    steps: [],
    attempt: 0,
  };

  const id = randomUUID();
  const created = await createRun({
    id,
    owner: identity.uid,
    projectId: project.id,
    repoFullName: project.repoFullName,
    state,
  });
  if (!created.ok) {
    // The reason decides the sentence. "Check the migration" was wrong for a
    // missing sealing key and for a refused grant, and it is the difference
    // between a five-second fix and a hunt through this repository.
    if (created.reason === "failed") {
      console.warn(`[agent] run insert refused: ${created.message}`);
    }
    const failure = runStartFailure(created.reason);
    return Response.json({ error: failure.error, detail: failure.detail }, { status: failure.status });
  }

  // The first link of the chain. The browser gets its run id now and the tick
  // owns the work from here — but the dispatch has to survive this response.
  // A bare `void fetch(...)` is cancelled with the invocation on a serverless
  // host, which left the run at `running` with no chain behind it and the chat
  // spinning on "Computing…" until the tab closed. `after` runs it once the
  // response has been flushed and keeps the invocation alive until it settles.
  const tickToken = signTick({ run: id, uid: identity.uid, attempt: 0 });
  const tickOrigin = internalOrigin(req);
  const fire = async () => {
    await dispatchTick(tickOrigin, tickToken);
  };
  try {
    after(fire);
  } catch {
    // Outside a request scope (a unit test, a script): the plain dispatch is
    // still better than not starting the run at all.
    void fire();
  }

  return Response.json({ run: { id, status: "running" } }, { status: 201 });
}

