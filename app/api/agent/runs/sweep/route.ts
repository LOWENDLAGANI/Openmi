import { NextRequest } from "next/server";
import { RUN_MAX_ATTEMPTS, RUN_STALE_MS, finishRun, listStaleRuns } from "@/lib/agentRuns";
import { dispatchTick, signTick } from "@/lib/agentRunToken";

// ── The watchdog ─────────────────────────────────────────────────────────────
//
// A chain link is a fire-and-forget request. Most arrive; the ones that do not —
// a deploy in the middle, a cold start that never woke, a process that died
// between the write and the dispatch — leave a run sitting at `running` with no
// one to advance it. That is the failure mode of every self-chaining design, and
// this endpoint is the answer to it.
//
// It is called by a scheduler (Supabase `pg_cron` + `pg_net` is the cheapest
// option, and needs no new vendor), authorised by a shared secret because it has
// no user and no run to bind to.
//
// It is safe to call as often as you like: the tick it fires still has to win a
// claim, so a sweep that races a live link does nothing at all.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** `x-openmi-sweep` must carry this. Unset means the sweep is off. */
function sweepSecret(): string {
  return process.env.AGENT_SWEEP_SECRET?.trim() ?? "";
}

export async function POST(req: NextRequest): Promise<Response> {
  const secret = sweepSecret();
  if (!secret) {
    return Response.json(
      { error: "The run watchdog is not configured. Set AGENT_SWEEP_SECRET to enable it.", detail: "sweep-unconfigured" },
      { status: 503 }
    );
  }
  const given = req.headers.get("x-openmi-sweep") ?? "";
  // Length check first so the comparison is not the thing that leaks the secret's shape.
  if (given.length !== secret.length || given !== secret) {
    return Response.json({ error: "Not allowed." }, { status: 403 });
  }

  const stale = await listStaleRuns(RUN_STALE_MS);
  let revived = 0;
  let abandoned = 0;

  for (const run of stale) {
    if (run.attempts >= RUN_MAX_ATTEMPTS) {
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
        error: "This run stopped responding and could not be resumed within its step budget.",
        usage: run.usage,
      });
      abandoned += 1;
      continue;
    }
    // The attempt number it holds is the one the claim will require, so a live
    // link that beats this sweep simply wins first and this dispatch does nothing.
    void dispatchTick(req.nextUrl.origin, signTick({ run: run.id, uid: run.owner, attempt: run.attempts }));
    revived += 1;
  }

  return Response.json({ checked: stale.length, revived, abandoned }, { headers: { "Cache-Control": "no-store" } });
}
