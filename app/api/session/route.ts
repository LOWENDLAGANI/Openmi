import { NextRequest } from "next/server";
import { checkRateLimit, isSameOriginRequest, rateLimitRefusal, verifyCaller } from "@/lib/serverControl";
import { clientForToken } from "@/lib/supabase";
import { HOUR_SESSION_MS, outOfDewMessage, sessionPrice } from "@/lib/dew";
import { readHourSession, type ActiveHourSession } from "@/lib/hourSession";

// ── One hour, one chat ──────────────────────────────────────────────────────
//
// The price is decided here, from the server's own price list — never from the
// body. The row and the charge are written by `start_hour_session()` in one
// transaction, so the only way to obtain the hour is to pay for it and the only
// way to hold two is to have two rows, which the primary key forbids.
//
// Two refusals are a choice rather than an error:
//   409 session-active  — this account is already in an hour; the answer names
//                         the chat that owns it so the client can offer
//                         "continue there" or "end it and start here".
//   402 insufficient   — the hour is more than today's free Dew plus the paid
//                         wallet, which is the moment the wallet page matters.
//
// Both travel as JSON because the composer acts on them, not on prose.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FLASH = "flash" as const;

interface SessionBody {
  action?: unknown;
  chatId?: unknown;
}

function sessionPayload(session: ActiveHourSession) {
  return {
    chatId: session.chatId,
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
      price: sessionPrice(FLASH),
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

  const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
  if (!chatId || chatId.length > 200) {
    return Response.json({ error: "A session needs a chat." }, { status: 400 });
  }

  const price = sessionPrice(FLASH);
  if (price === null) {
    return Response.json({ error: "This model has no hour session." }, { status: 400 });
  }

  // No price in the call: the function charges its own constant. Sending one
  // would make the price client-chosen, and any signed-in account can call
  // this RPC directly.
  const { data, error } = await client.rpc("start_hour_session", { p_chat_id: chatId });
  if (error) return sessionUnavailable(error);

  const result = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!result || result.ok !== true) {
    if (result?.reason === "active") {
      return Response.json(
        {
          code: "session-active",
          error:
            "An hour session is already running. Continue in that chat, or end it before starting a new one here.",
          chatId: typeof result.chat_id === "string" ? result.chat_id : "",
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
    return Response.json({ error: "The session could not be started." }, { status: 502 });
  }

  const session = await readHourSession(authorization, identity.uid);
  return Response.json(
    {
      ok: true,
      price: number(result.price) || price,
      session: session
        ? sessionPayload(session)
        : {
            chatId: typeof result.chat_id === "string" ? result.chat_id : chatId,
            price: number(result.price) || price,
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
        ? "Hour sessions are not available on this deployment yet: apply migration 20261028000000_pricing_sessions.sql."
        : "The session could not be changed. Try again in a moment.",
    },
    { status: 503 }
  );
}
