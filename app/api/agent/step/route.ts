import { NextRequest } from "next/server";
import {
  isSameOriginRequest,
  checkRateLimit,
  identityGate,
  isAdmin,
  rateLimitRefusal,
  readConfig,
  verifyCaller,
} from "@/lib/serverControl";
import { readProject, refreshProjectHead } from "@/lib/projects";
import { readUserKeys } from "@/lib/providerKeys";
import { resolveGithubLink } from "@/lib/github/store";
import { GithubError } from "@/lib/github/client";
import { runAgentStep } from "@/lib/agent/run";
import { cleanHistory, cleanTranscript } from "@/lib/agent/transcript";
import { buildChangeSet, saveChangeSet } from "@/lib/changesets";
import { outOfDewMessage } from "@/lib/dew";
import { readHourSession } from "@/lib/hourSession";

// ── One agent step, streamed ─────────────────────────────────────────────────
//
// The client drives the loop: send a step, render what came back, send the next
// one. That keeps each request inside the host's time limit and gives "stop" a
// meaning — cancelling the fetch cancels the step.
//
// A step used to be a single JSON response, which meant the answer to "what is
// it doing?" was nothing until the whole step finished. It is now one JSON
// object per line (NDJSON) over a streamed response, emitted as the work
// happens: `thinking`, then a `step` line when a tool starts and another when it
// finishes, `delta` lines as the model writes, and one `done` line carrying the
// same state the JSON response used to carry. Everything before the model call
// — the checks, the balance, the project — still answers with a JSON error and
// a status code, because those are refusals, not progress.
//
// What the client *cannot* choose is the budget. Steps used and tokens spent
// live in a signed blob (lib/agent/turns.ts); the client carries it and can read
// it, but any edit invalidates it.
//
// The agent is not billed per turn. It draws on the account's hour session — the
// same hour chat uses — so a long turn costs exactly what a short one costs, and
// nothing is charged while the hour runs. An administrator is exempt, as
// everywhere else. A proposal is part of the turn that produced it: staging does
// not cost extra and does not write to GitHub.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface StepBody {
  projectId?: unknown;
  history?: unknown;
  transcript?: unknown;
  turnToken?: unknown;
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
    return rateLimitRefusal(limit, `Too many agent steps at once. Please wait ${limit.retryAfterSeconds}s and try again.`);
  }
  const gate = identityGate(identity, config, config.dailyChatCap);
  if (!gate.allowed) {
    return Response.json({ error: gate.error ?? "Openmi is not available to this device." }, { status: 403 });
  }

  let body: StepBody;
  try {
    body = (await req.json()) as StepBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) {
    return Response.json({ error: "A project is required." }, { status: 400 });
  }

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

  // ── Read the branch as it is now ──────────────────────────────────────────
  // The project's pin was only ever taken when the repository was attached, so
  // one push to the default branch made every later proposal stale against a
  // commit that was no longer the tip — the review screen then refused it with
  // "main has moved since this change was proposed" no matter how many times
  // the change was asked for again. Refreshing here means a proposal is always
  // relative to the current tip; the commit endpoint still refuses a change
  // whose branch moved while it was being reviewed, which is the window that
  // check exists for.
  project = await refreshProjectHead(authorization, identity.uid, project, link.token);

  // The model keys this account brought, opened here and never sent back to the
  // browser. The agent prefers them over the deployment's, exactly as chat
  // does.
  const accountKeys = await readUserKeys(authorization, identity.uid);

  // ── The hour ──────────────────────────────────────────────────────────────
  // Checked before the model runs, exactly like /api/chat. The agent draws on the
  // same hour as chat — one unit for the whole product — so a step is covered
  // when the account has one and refused when it does not. No step has a price
  // of its own, which is what makes a long turn cost the same as a short one.
  const isCallerAdmin = isAdmin(identity);

  if (!isCallerAdmin) {
    const session = await readHourSession(authorization, identity.uid);
    if (!session) {
      return Response.json({ error: outOfDewMessage() }, { status: 402 });
    }
  }

  const history = cleanHistory(body.history);
  if (history.length === 0) {
    return Response.json({ error: "A conversation is required." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true; // The client went away mid-line; the work is stopped below.
        }
      };

      try {
        const result = await runAgentStep({
          authorization,
          uid: identity.uid,
          project,
          token: link.token,
          accountKeys,
          history,
          transcript: cleanTranscript(body.transcript),
          turnToken: typeof body.turnToken === "string" ? body.turnToken : undefined,
          signal: req.signal,
          onEvent: send,
        });

        // The step was covered by the account's hour, so nothing is charged per
        // turn: `result.usage` is recorded with the transcript, not billed.

        // ── The proposal, made reviewable ───────────────────────────────────
        // Staging lives in memory for the length of this request, so a proposal
        // that is not written down here is a diff the user can read once and can
        // never commit. The row is signed by the server; the signature — not the
        // row — is what the approve and commit endpoints will check.
        let changesetId: string | null = null;
        let changesetWarning: string | null = null;
        if (result.proposals.length > 0) {
          const changeSet = buildChangeSet({ project, proposals: result.proposals });
          if (changeSet) {
            const stored = await saveChangeSet(authorization, identity.uid, changeSet).catch(() => false);
            if (stored) changesetId = changeSet.id;
            else
              changesetWarning =
                "This change could not be saved for review, so it cannot be committed from here. Check the `change_sets` policies in the Supabase project.";
          }
        }

        send({
          type: "done",
          content: result.content,
          steps: result.steps,
          transcript: result.transcript,
          turnToken: result.turnToken,
          done: result.done,
          exhausted: result.exhausted,
          model: result.label,
          usage: { prompt: result.usage.prompt, completion: result.usage.completion },
          charged: result.chargedNow,
          // Staged changes, with diffs the server computed. They are returned for
          // display only: this route has no path to a GitHub write, and the
          // change set is committed only by the commit endpoint, after approval.
          proposals: result.proposals,
          // The pre-flight review, live only: it is a report about the diff,
          // not part of the signed change set, so a reload shows the change
          // without it rather than claiming a check that is not stored.
          review: result.review,
          changesetId,
          changesetWarning,
        });
      } catch (error) {
        if (req.signal.aborted) return;
        if (error instanceof GithubError) {
          send({ type: "error", error: error.message, status: error.status, resetAt: error.resetAt ?? null });
        } else {
          const message = error instanceof Error ? error.message : "The repository agent failed.";
          console.error("[agent] step failed", error);
          send({ type: "error", error: message, status: 502 });
        }
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by an abort.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
