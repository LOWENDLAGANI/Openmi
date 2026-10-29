import { NextRequest } from "next/server";
import { runAgentStep } from "@/lib/agent/run";
import type { AgentMessage } from "@/lib/agent/model";
import type { StagedChange } from "@/lib/agent/edits";
import {
  RUN_MAX_ATTEMPTS,
  claimRun,
  finishRun,
  openRunState,
  readRun,
  saveProgress,
  type AgentRunState,
} from "@/lib/agentRuns";
import { dispatchTick, signTick, verifyTick } from "@/lib/agentRunToken";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildChangeSet, changeSetRow } from "@/lib/changesets";
import type { AgentStep } from "@/lib/types";

// ── One step of a run, on the server's own authority ─────────────────────────
//
// This is the endpoint that makes "send it and close the tab" true. It is not
// called by a browser: the caller is the chain link before it, or the watchdog,
// and the proof is a signed claim naming the run, its owner and the attempt
// being advanced.
//
// One tick does exactly one step and then hands on. That shape is deliberate —
// a step must finish well inside the function limit, and a chain that dies is a
// heartbeat the watchdog can see, rather than a request that timed out with no
// trace of how far it got.
//
// The claim is the safety property. `claimRun` only advances the row when the
// attempt is still current, so a token that is replayed — a retried fetch, a
// duplicated dispatch — finds nothing to claim and spends no model call, no
// GitHub request and no step of the turn's budget.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface TickBody {
  token?: unknown;
}

/** The message a person sees when a run could not be kept going. */
const LOST_STATE =
  "This run could not be resumed — its saved state was missing or unreadable. Start the question again.";

function mergeSteps(previous: AgentStep[], next: AgentStep[]): AgentStep[] {
  return [...previous, ...next].map((step) => ({ tool: step.tool, label: step.label, ok: step.ok, ...(step.detail ? { detail: step.detail } : {}) }));
}

/** Saves the change set a step staged, with the service key: a tick has no caller. */
async function storeChangeSet(uid: string, state: AgentRunState, proposals: StagedChange[]): Promise<string | null> {
  const admin = supabaseAdmin();
  if (!admin || proposals.length === 0) return null;
  const changeSet = buildChangeSet({ project: state.project, proposals });
  if (!changeSet) return null;
  try {
    const { error } = await admin.from("changesets").upsert(changeSetRow(uid, changeSet), { onConflict: "owner,id" });
    return error ? null : changeSet.id;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: TickBody;
  try {
    body = (await req.json()) as TickBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const claim = typeof body.token === "string" ? verifyTick(body.token) : null;
  if (!claim) return Response.json({ error: "That tick is not valid." }, { status: 401 });

  const run = await readRun(claim.run);
  if (!run || run.owner !== claim.uid) return Response.json({ error: "No such run." }, { status: 404 });
  if (run.status !== "running") return Response.json({ run: "finished" }, { status: 200 });
  if (run.attempts !== claim.attempt) return Response.json({ run: "claimed" }, { status: 200 });

  const claimed = await claimRun(run.id, run.owner, claim.attempt);
  if (!claimed) return Response.json({ run: "claimed" }, { status: 200 });

  const state = openRunState(run.state);
  if (!state) {
    // The sealed blob is the run. Without it there is nothing to advance, and
    // pretending otherwise would be a second, emptier answer to the same question.
    await finishRun({
      id: run.id,
      owner: run.owner,
      status: "failed",
      content: run.content,
      steps: run.steps,
      proposals: run.proposals,
      changesetId: run.changesetId,
      review: run.review,
      truncated: run.truncated,
      error: LOST_STATE,
      usage: run.usage,
    });
    return Response.json({ run: "failed" }, { status: 200 });
  }

  const attempt = claim.attempt;
  const nextAttempt = attempt + 1;

  try {
    const result = await runAgentStep({
      authorization: null,
      uid: state.uid,
      project: state.project,
      token: state.githubToken,
      accountKeys: state.accountKeys,
      history: state.history,
      transcript: state.transcript as AgentMessage[],
      turnToken: state.turnToken,
      context: state.context,
    });

    const content = result.content.trim()
      ? state.content
        ? `${state.content}\n\n${result.content}`
        : result.content
      : state.content;
    const steps = mergeSteps(state.steps, result.steps);
    const usage = {
      prompt: run.usage.prompt + result.usage.prompt,
      completion: run.usage.completion + result.usage.completion,
    };

    // A proposal is saved the moment it exists. If the chain dies on the next
    // link, the diff the person can review is already durable.
    const changesetId =
      (await storeChangeSet(state.uid, state, result.proposals)) ?? run.changesetId;

    if (result.done || result.exhausted) {
      await finishRun({
        id: run.id,
        owner: run.owner,
        status: "done",
        content,
        steps,
        proposals: result.proposals,
        changesetId,
        review: result.review,
        truncated: result.exhausted,
        error: null,
        usage,
      });
      return Response.json({ run: "done" }, { status: 200 });
    }

    const nextState: AgentRunState = {
      ...state,
      transcript: result.transcript,
      turnToken: result.turnToken,
      content,
      steps,
      attempt: nextAttempt,
    };

    const saved = await saveProgress({ id: run.id, state: nextState, content, steps, usage });
    if (!saved) {
      await finishRun({
        id: run.id,
        owner: run.owner,
        status: "failed",
        content,
        steps,
        proposals: result.proposals,
        changesetId,
        review: result.review,
        truncated: false,
        error: "This run could not save its progress, so it stopped rather than repeating the same step.",
        usage,
      });
      return Response.json({ run: "failed" }, { status: 200 });
    }

    // Hand on. Not awaited: this request is done, and the next step has its own
    // fixed budget.
    if (nextAttempt < RUN_MAX_ATTEMPTS) {
      void dispatchTick(req.nextUrl.origin, signTick({ run: run.id, uid: state.uid, attempt: nextAttempt }));
    } else {
      await finishRun({
        id: run.id,
        owner: run.owner,
        status: "done",
        content,
        steps,
        proposals: result.proposals,
        changesetId,
        review: result.review,
        truncated: true,
        error: null,
        usage,
      });
    }

    return Response.json({ run: "running" }, { status: 200 });
  } catch (error) {
    await finishRun({
      id: run.id,
      owner: run.owner,
      status: "failed",
      content: run.content,
      steps: run.steps,
      proposals: run.proposals,
      changesetId: run.changesetId,
      review: run.review,
      truncated: run.truncated,
      error: error instanceof Error ? error.message.slice(0, 400) : "The repository agent failed.",
      usage: run.usage,
    });
    return Response.json({ run: "failed" }, { status: 200 });
  }
}

