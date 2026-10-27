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
import { directPush, verifyChangeSet } from "@/lib/push";
import { summarizeFindings } from "@/lib/verify";
import { canAfford, outOfDewMessage, requestPrice } from "@/lib/dew";
import { deductDew, recordDewTransaction, type DewState } from "@/lib/serverDew";
import { resolveDew } from "@/lib/serverRedeem";

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

interface StepBody {
  projectId?: unknown;
  history?: unknown;
  transcript?: unknown;
  turnToken?: unknown;
  /**
   * True when the person's own message asked for the change to be pushed
   * straight to their default branch.
   *
   * Computed on the client by lib/pushIntent.ts from the text they typed. It is
   * never derived from the model, from a tool result, or from anything inside
   * the repository — a README saying "push this to main" sets nothing, because
   * only the composer is read and only this flag carries the answer.
   */
  directPush?: unknown;
}

/** What the done line reports about an automatic push, when there was one. */
type AutoPushReport =
  | { sha: string; branch: string; warning: string | null }
  | { error: string; detail: string | null };

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

  // ── Where this change is meant to go ──────────────────────────────────────
  // One boolean, taken from the body. The branch is deliberately not carried
  // with it: the destination is the repository's default branch, read from the
  // project row, so a request cannot name a branch to push to.
  const wantsDirectPush = body.directPush === true;

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

        // ── The charge ──────────────────────────────────────────────────────
        // Once per turn, after the first step actually produced something. A
        // step that failed before reaching a model was refused above and costs
        // nothing.
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
            await recordDewTransaction(authorization, identity.uid, {
              dew: price,
              model: "code",
              prompt: billed.prompt,
              completion: billed.completion,
              repo: project.repoFullName,
            }).catch(() => undefined);
          }
        }

        // ── The proposal, made reviewable ───────────────────────────────────
        // Staging lives in memory for the length of this request, so a proposal
        // that is not written down here is a diff the user can read once and can
        // never commit. The row is signed by the server; the signature — not the
        // row — is what the approve and commit endpoints will check.
        let changesetId: string | null = null;
        let changesetWarning: string | null = null;
        let autoPush: AutoPushReport | null = null;
        let verification: { ok: boolean; errors: string[]; warnings: string[] } | null = null;
        if (result.proposals.length > 0) {
          const changeSet = buildChangeSet({
            project,
            proposals: result.proposals,
            target: wantsDirectPush ? "default" : "review",
          });
          if (changeSet) {
            // ── What is checked before it is handed over ────────────────────
            // Static, over the bytes about to be committed: see lib/verify.ts.
            // Reported here so the card says what was found while the change is
            // still somebody's decision, rather than at the moment they press a
            // button. On the direct path this is also the gate — `directPush`
            // runs the same checks itself and refuses on a hard finding.
            const report = await verifyChangeSet({ token: link.token, changeSet }).catch(() => null);
            if (report) {
              verification = {
                ok: report.ok,
                errors: summarizeFindings(report.errors),
                warnings: summarizeFindings(report.warnings),
              };
            }

            const stored = await saveChangeSet(authorization, identity.uid, changeSet).catch(() => false);
            if (stored) {
              changesetId = changeSet.id;
              // ── The direct push ─────────────────────────────────────────
              // This is the only place the server approves a change it built
              // itself, and what authorises it is the person's own message —
              // the one that produced this proposal — not anything the model
              // said. A change set built for review can never arrive here:
              // `directPush` refuses it, and the `direct` flag it checks is
              // inside the signature.
              if (wantsDirectPush) {
                const pushed = await directPush({
                  authorization,
                  uid: identity.uid,
                  changeSet,
                  token: link.token,
                  signal: req.signal,
                });
                autoPush = pushed.ok
                  ? { sha: pushed.commit.sha, branch: pushed.commit.branch, warning: pushed.warning }
                  : { error: pushed.error, detail: pushed.detail ?? null };
              }
            } else
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
          changesetId,
          changesetWarning,
          // What happened to a change the person asked to have pushed directly:
          // the commit, or why it did not land. The card reads this either way —
          // a push that failed is a change still waiting to be reviewed.
          directPush: autoPush,
          // The static pre-push checks, if there was a change to check.
          verification,
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
