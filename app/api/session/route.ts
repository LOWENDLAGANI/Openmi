import { NextRequest } from "next/server";
import {
  checkRateLimit,
  identityGate,
  isAdmin,
  isSameOriginRequest,
  rateLimitRefusal,
  readConfig,
  verifyCaller,
} from "@/lib/serverControl";
import { clientForToken } from "@/lib/supabase";
import { DEW_PER_HOUR, HOUR_SESSION_MS, outOfDewMessage } from "@/lib/dew";
import { readProject, isProjectId } from "@/lib/projects";
import {
  autoRefundIdleHour,
  hourModelRefusal,
  hourRepoRefusal,
  normalizeHourModel,
  readHourSession,
  refundHourSession,
  type ActiveHourSession,
} from "@/lib/hourSession";
import { DEFAULT_MODE_ID, type ModeId } from "@/lib/models";

// ── One hour, one model, one repository ─────────────────────────────────────
//
// Openmi charges for time, not for messages: three Dew opens an hour. This route
// is the only way to buy one, and it takes exactly what the hour is for — the
// model the buyer picked and, when they are working in a repository, that
// repository. The price is the server's own constant, never the body's, so a
// modified client cannot buy an hour for less.
//
// The same RPC writes the row and moves the wallet in one transaction, so the
// only way to hold an hour is to have paid for it, and the primary key on the
// account makes a second one impossible. The RPC also re-validates the model and
// the repository, because a signed-in account can call it directly through
// PostgREST.
//
// Three refusals are a choice rather than an error:
//   409 session-active       — this account already has an equivalent hour
//                              running; the answer carries it so the client can
//                              simply use it.
//   409 session-model-locked — the live hour is for another model. The message
//                              names it and offers the two choices: continue
//                              with it, or end the hour and start this one.
//   409 session-repo-locked  — the live hour is for another repository (or for
//                              no repository at all).
//   402 insufficient        — the hour is more than today's free Dew plus the
//                              paid wallet, which is the moment the wallet page
//                              matters.
//
// All travel as JSON because the composer acts on them, not on prose.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionBody {
  action?: unknown;
  /** The model the hour is bought for. Missing reads as the product default. */
  model?: unknown;
  /** The repository the hour is bought for; absent for ordinary chat. */
  projectId?: unknown;
  /** For `refund`: why the hour is being given back. Kept short and logged. */
  reason?: unknown;
}

function sessionPayload(session: ActiveHourSession) {
  return {
    price: session.price,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    model: session.model,
    projectId: session.projectId,
    repoFullName: session.repoFullName,
  };
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The hour a refusal is talking about, read from the RPC's own answer.
 *
 * The RPC echoes the live binding, so this needs no second query and cannot
 * describe an hour that has already expired: `ends` is the row's own expiry.
 */
function activeFromRpc(result: Record<string, unknown>): ActiveHourSession {
  return {
    price: number(result.price) || DEW_PER_HOUR,
    startedAt: Date.now(),
    expiresAt: Date.parse(String(result.expires_at ?? "")) || Date.now() + HOUR_SESSION_MS,
    model: normalizeHourModel(result.model),
    projectId: nullableText(result.project_id),
    repoFullName: nullableText(result.repo_full_name),
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to see your session." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "hour-session");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, "Too many session checks. Try again shortly.");
  }

  // An hour that was bought and then never used is given back here, on the read
  // that a returning browser makes first. The database refuses anything with a
  // prompt or an answer, so this is the abandoned-tab rail and nothing more.
  const refund = await autoRefundIdleHour(authorization);

  const session = await readHourSession(authorization, identity.uid);
  return Response.json(
    {
      session: session ? sessionPayload(session) : null,
      price: DEW_PER_HOUR,
      durationMs: HOUR_SESSION_MS,
      refund,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return Response.json({ error: "This request did not come from Openmi.", detail: "cross-origin" }, { status: 403 });
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return Response.json({ error: "Sign in to start a session." }, { status: 401 });
  }

  const limit = await checkRateLimit(req, identity, "hour-session");
  if (!limit.allowed) {
    return rateLimitRefusal(limit, `Too many session changes. Try again in ${limit.retryAfterSeconds}s.`);
  }

  let body: SessionBody;
  try {
    body = (await req.json()) as SessionBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = token ? clientForToken(token) : null;
  if (!client) {
    return Response.json({ error: "Sign in to start a session." }, { status: 401 });
  }

  // ── Giving an hour back ───────────────────────────────────────────────────
  // The chat and agent routes call this themselves when they fail before an
  // answer exists. The browser calls it too, for the failures the server never
  // sees — a request that never arrived, a stream that dropped. The database
  // refuses anything that produced a reply, so a duplicate or a late call is a
  // no-op rather than a second refund.
  if (body.action === "refund") {
    const refund = await refundHourSession(
      authorization,
      typeof body.reason === "string" ? body.reason : "request-failed"
    );
    return Response.json(
      { refunded: refund?.refunded ?? 0, refund },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (body.action === "end") {
    const { data, error } = await client.rpc("end_hour_session");
    if (error) return sessionUnavailable(error);
    return Response.json({ ended: data === true }, { headers: { "Cache-Control": "no-store" } });
  }

  if (body.action !== "start") {
    return Response.json({ error: "That is not a session action." }, { status: 400 });
  }

  // ── The gates the chat routes apply, applied before money moves ───────────
  // An hour is only worth buying to ask something, and a ban or maintenance
  // mode refuses exactly that. Without this a banned account could pay for an
  // hour it cannot spend and then wait for the idle refund — the refusal would
  // arrive one step too late, after the balance had already gone down.
  //
  // `refund` and `end` above are deliberately not gated: taking an hour back
  // must work during a ban, or the rail that returns Dew becomes the thing that
  // is switched off when it is needed.
  const config = await readConfig();
  if (config.maintenanceEnabled && !isAdmin(identity)) {
    return Response.json(
      { error: config.maintenanceMessage },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const gate = identityGate(identity, config, config.dailyChatCap);
  if (!gate.allowed) {
    return Response.json(
      { error: gate.error },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  // ── What this hour is for ─────────────────────────────────────────────────
  // The model is one of the product's modes; anything else is refused here and
  // again in the database. A missing model is the product default, so a client
  // written before this rule still buys an hour it can actually use.
  const requestedModel: ModeId | null =
    body.model === undefined || body.model === null || body.model === ""
      ? DEFAULT_MODE_ID
      : body.model === "auto" || body.model === "code" || body.model === "flash"
        ? body.model
        : null;
  if (!requestedModel) {
    return Response.json({ error: "That is not a model Openmi offers." }, { status: 400 });
  }

  // The repository is validated as this account's own project before the RPC
  // sees it. An id that is not owned is refused as not attached, which is the
  // same answer as not existing: another account's project is not a fact this
  // route is willing to confirm.
  const requestedProjectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  let project = null;
  if (requestedProjectId) {
    if (!isProjectId(requestedProjectId)) {
      return Response.json({ error: "That is not a repository id." }, { status: 400 });
    }
    project = await readProject(authorization, identity.uid, requestedProjectId);
    if (!project) {
      return Response.json({ error: "That repository is not attached to this account." }, { status: 404 });
    }
  }

  const { data, error } = await client.rpc("start_hour_session", {
    p_model: requestedModel,
    p_project_id: project?.id ?? null,
  });
  if (error) return sessionUnavailable(error);

  const result = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    if (result?.reason === "active") {
      const active = activeFromRpc(result);
      const locked = {
        price: active.price,
        startedAt: active.startedAt,
        expiresAt: active.expiresAt,
        model: active.model,
        projectId: active.projectId,
        repoFullName: active.repoFullName,
      };

      if (active.model !== requestedModel) {
        return Response.json(
          {
            code: "session-model-locked",
            error: hourModelRefusal(active, requestedModel),
            session: locked,
          },
          { status: 409, headers: { "Cache-Control": "no-store" } }
        );
      }
      // The repository is only a conflict when one is being asked for. An hour
      // bought on a repository still covers ordinary chat on its own model,
      // which is the one thing it was sold as covering.
      if (project && active.projectId !== project.id) {
        return Response.json(
          {
            code: "session-repo-locked",
            error: hourRepoRefusal(active, project.repoFullName),
            session: locked,
          },
          { status: 409, headers: { "Cache-Control": "no-store" } }
        );
      }
      return Response.json(
        {
          code: "session-active",
          error: "An hour is already running on this account.",
          expiresAt: active.expiresAt,
          session: locked,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (result?.reason === "insufficient") {
      return Response.json(
        {
          code: "insufficient-dew",
          error: outOfDewMessage(),
          available: number(result.available),
        },
        { status: 402, headers: { "Cache-Control": "no-store" } }
      );
    }
    return Response.json({ error: "The hour could not be started." }, { status: 502 });
  }

  const session = await readHourSession(authorization, identity.uid);
  return Response.json(
    {
      ok: true,
      price: number(result.price) || DEW_PER_HOUR,
      session: session
        ? sessionPayload(session)
        : {
            price: number(result.price) || DEW_PER_HOUR,
            startedAt: Date.now(),
            expiresAt: Date.parse(String(result.expires_at ?? "")) || Date.now() + HOUR_SESSION_MS,
            model: normalizeHourModel(result.model),
            projectId: nullableText(result.project_id),
            repoFullName: nullableText(result.repo_full_name),
          },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** A missing function is a missing migration, said in those words. */
function sessionUnavailable(error: { code?: string; message?: string }): Response {
  const missing = error.code === "PGRST202";
  console.warn(`[session] ${missing ? "migration missing" : "call failed"}: ${error.message ?? "unknown"}`);
  return Response.json(
    {
      error: missing
        ? "Hour sessions are not available on this deployment yet: apply migration 20261028000300_session_scope.sql."
        : "The session could not be changed. Try again in a moment.",
    },
    { status: 503 }
  );
}
