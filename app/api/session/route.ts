import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, rateLimitRefusal, verifyCaller } from "@/lib/serverControl";
import { clientForToken } from "@/lib/supabase";
import { DEW_PER_HOUR, HOUR_SESSION_MS, outOfDewMessage } from "@/lib/dew";
import { readHourSession, type ActiveHourSession } from "@/lib/hourSession";

// ── One hour, every chat ────────────────────────────────────────────────────
//
// Openmi charges for time, not for messages: three Dew opens an hour that covers
// every answer in every chat and on every model. This route is the only way to
// buy one, and the price is the server's own constant — never the body's — so a
// modified client cannot buy an hour for less.
//
// The same RPC writes the row and moves the wallet in one transaction, so the
// only way to hold an hour is to have paid for it, and the primary key on the
// account makes a second one impossible.
//
// Two refusals are a choice rather than an error:
//   409 session-active  — this account already has an hour running; the answer
//                         carries its expiry so the client can just use it.
//   402 insufficient   — the hour is more than today's free Dew plus the paid
//                         wallet, which is the moment the wallet page matters.
//
// Both travel as JSON because the composer acts on them, not on prose.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SessionBody {
  action?: unknown;
}

function sessionPayload(session: ActiveHourSession) {
  return {
    price: session.price,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
  };
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

  const session = await readHourSession(authorization, identity.uid);
  return Response.json(
    {
      session: session ? sessionPayload(session) : null,
      price: DEW_PER_HOUR,
      durationMs: HOUR_SESSION_MS,
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

  if (body.action === "end") {
    const { data, error } = await client.rpc("end_hour_session");
    if (error) return sessionUnavailable(error);
    return Response.json({ ended: data === true }, { headers: { "Cache-Control": "no-store" } });
  }

  if (body.action !== "start") {
    return Response.json({ error: "That is not a session action." }, { status: 400 });
  }

  // No price and no chat in the call: the hour is the account's, and the
  // function charges its own constant.
  const { data, error } = await client.rpc("start_hour_session");
  if (error) return sessionUnavailable(error);

  const result = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    if (result?.reason === "active") {
      return Response.json(
        {
          code: "session-active",
          error: "An hour is already running on this account.",
          expiresAt: Date.parse(String(result.expires_at ?? "")) || 0,
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
        ? "Hour sessions are not available on this deployment yet: apply migration 20261028000200_charge_dew.sql."
        : "The session could not be changed. Try again in a moment.",
    },
    { status: 503 }
  );
}
