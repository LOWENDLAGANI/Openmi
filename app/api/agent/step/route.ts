import { NextRequest } from "next/server";
import {
  isSameOriginRequest,
  checkRateLimit,
  identityGate,
  isAdmin,
  readConfig,
  verifyCaller,
  writeAsCaller,
} from "@/lib/serverControl";
import { readProject } from "@/lib/projects";
import { readGithubLink } from "@/lib/github/store";
import { GithubError } from "@/lib/github/client";
import { runAgentStep, type RepoChatMessage } from "@/lib/agent/run";
import type { AgentMessage } from "@/lib/agent/model";
import { canAfford, outOfDewMessage, requestPrice } from "@/lib/dew";
import { deductDew, type DewState } from "@/lib/serverDew";
import { resolveDew } from "@/lib/serverRedeem";

// ── One agent step ───────────────────────────────────────────────────────────
//
// The client drives the loop: send a step, render what came back, send the next
// one. That keeps each request inside the host's time limit and gives "stop" a
// meaning — cancelling the fetch cancels the step.
//
// What the client *cannot* choose is the budget. Steps used, tokens spent and
// "this turn has been paid for" live in a signed blob (lib/agent/turns.ts); the
// client carries it and can read it, but any edit invalidates it. A new turn
// starts a new charge, and the charge is flat for the model, not per step.
//
// The price is `requestPrice("code")` because repository work runs on the Code
// model. An administrator is exempt, as everywhere else. A proposal is part of
// the turn that produced it: staging does not cost extra and does not write to
// GitHub, so the flat charge is unchanged.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 40_000;
const MAX_TRANSCRIPT_ENTRIES = 60;
const MAX_TRANSCRIPT_CHARS = 240_000;

interface StepBody {
  projectId?: unknown;
  history?: unknown;
  transcript?: unknown;
  turnToken?: unknown;
}

function cleanHistory(raw: unknown): RepoChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: RepoChatMessage[] = [];
  let chars = 0;
  for (const entry of raw.slice(-MAX_HISTORY_MESSAGES)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.role !== "user" && value.role !== "assistant") continue;
    if (typeof value.content !== "string" || !value.content.trim()) continue;
    const content = value.content.slice(0, 12_000);
    chars += content.length;
    if (chars > MAX_HISTORY_CHARS) break;
    out.push({ role: value.role, content });
  }
  return out;
}

/**
 * Validates the echoed transcript.
 *
 * It is model-shaped data that has made a round trip through the browser, so
 * nothing about it is trusted: roles are an allowlist, content is capped, and a
 * tool call must carry a name and string arguments. An entry that fails is
 * dropped rather than repaired — a half-valid conversation is worse than a
 * shorter one.
 */
function cleanTranscript(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMessage[] = [];
  let chars = 0;
  for (const entry of raw.slice(-MAX_TRANSCRIPT_ENTRIES)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const role = value.role;
    if (role !== "assistant" && role !== "tool" && role !== "user") continue;
    const content = typeof value.content === "string" ? value.content.slice(0, 24_000) : null;
    chars += content?.length ?? 0;
    if (chars > MAX_TRANSCRIPT_CHARS) break;

    if (role === "tool") {
      if (typeof value.tool_call_id !== "string") continue;
      out.push({
        role: "tool",
        tool_call_id: value.tool_call_id,
        name: typeof value.name === "string" ? value.name.slice(0, 40) : undefined,
        content,
      });
      continue;
    }

    const toolCalls = Array.isArray(value.tool_calls)
      ? value.tool_calls
          .slice(0, 4)
          .map((call) => {
            if (!call || typeof call !== "object") return null;
            const fn = (call as Record<string, unknown>).function as Record<string, unknown> | undefined;
            if (!fn || typeof fn.name !== "string") return null;
            return {
              id: typeof (call as Record<string, unknown>).id === "string" ? ((call as Record<string, unknown>).id as string) : "",
              type: "function" as const,
              function: {
                name: fn.name.slice(0, 40),
                arguments: typeof fn.arguments === "string" ? fn.arguments.slice(0, 8_000) : "{}",
              },
            };
          })
          .filter((call): call is NonNullable<typeof call> => call !== null)
      : [];

    out.push({
      role,
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
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

  const limit = await checkRateLimit(req, identity, 20, "agent");
  if (!limit.allowed) {
    return Response.json(
      { error: `Too many agent steps at once. Please wait ${limit.retryAfterSeconds}s and try again.` },
      { status: 429 }
    );
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

  const project = await readProject(authorization, identity.uid, projectId);
  if (!project) {
    return Response.json({ error: "That project is not attached to this account." }, { status: 404 });
  }

  const link = await readGithubLink(authorization, identity.uid);
  if (!link) {
    return Response.json(
      { error: "Connect GitHub again to continue.", detail: "not-connected" },
      { status: 401 }
    );
  }

  // ── The Dew ledger ────────────────────────────────────────────────────────
  // Checked before the model runs, exactly like /api/chat. A turn that is
  // continuing on a signed token has already been paid for; the balance is only
  // re-read when this is the first step.
  const isCallerAdmin = isAdmin(identity);
  const price = requestPrice("code");
  const continuing = typeof body.turnToken === "string" && body.turnToken.length > 0;
  let dewState: DewState | null = null;

  if (!isCallerAdmin && !continuing) {
    dewState = await resolveDew(authorization, identity.uid);
    if (!canAfford(dewState.balance, price)) {
      return Response.json({ error: outOfDewMessage() }, { status: 402 });
    }
  }

  const history = cleanHistory(body.history);
  if (history.length === 0) {
    return Response.json({ error: "A conversation is required." }, { status: 400 });
  }

  try {
    const result = await runAgentStep({
      authorization,
      uid: identity.uid,
      project,
      token: link.token,
      history,
      transcript: cleanTranscript(body.transcript),
      turnToken: typeof body.turnToken === "string" ? body.turnToken : undefined,
      signal: req.signal,
    });

    // ── The charge ────────────────────────────────────────────────────────
    // Once per turn, after the first step actually produced something. A step
    // that failed before reaching a model was refused above and costs nothing.
    if (result.chargedNow && !isCallerAdmin && dewState && (result.content.trim() || result.steps.length > 0)) {
      const billed = result.usage;
      const deducted = await deductDew(authorization, identity.uid, dewState.spent, price).catch(
        (cause: unknown) => ({
          ok: false,
          newSpent: dewState!.spent,
          conflict: false,
          reason: cause instanceof Error ? cause.message : "threw",
        })
      );
      if (!deducted.ok) {
        console.warn(
          `[dew] agent charge of ${price} not recorded for uid ${identity.uid} (conflict=${deducted.conflict}, reason=${deducted.reason ?? "unknown"})`
        );
      } else {
        await writeAsCaller(
          authorization,
          `dew/${identity.uid}/tx/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          {
            type: "usage",
            at: Date.now(),
            dew: price,
            model: "code",
            prompt: billed.prompt,
            completion: billed.completion,
            repo: project.repoFullName,
          }
        ).catch(() => undefined);
      }
    }

    return Response.json(
      {
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
        // review only: this route has no path to a GitHub write, and a change
        // set is committed by the approval endpoint once it exists.
        proposals: result.proposals,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof GithubError) {
      const status = error.status === 401 ? 401 : error.status === 429 ? 429 : 502;
      return Response.json({ error: error.message, resetAt: error.resetAt ?? null }, { status });
    }
    const message = error instanceof Error ? error.message : "The repository agent failed.";
    console.error("[agent] step failed", error);
    return Response.json({ error: message }, { status: 502 });
  }
}
