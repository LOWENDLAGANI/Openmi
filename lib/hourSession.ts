// ── The hour that covers one chat (server only) ─────────────────────────────
//
// The row is written by `start_hour_session()` and read here with the caller's
// own token. Nothing in this module decides whether a session may start: that
// is the database function's job, because the only safe place for "one active
// session per account" is beside the primary key that enforces it. This module
// answers the two questions the chat route asks before it bills:
//
//   * does this account have a live session at all?
//   * is it the session for the chat being answered?
//
// A read that fails is "no session", never "free answers". The fallback costs a
// per-request charge, which is the direction a billing bug should err in.

import { clientForToken } from "./supabase";

export interface ActiveHourSession {
  chatId: string;
  /** The wire-facing model label stored with the session. */
  model: string;
  price: number;
  startedAt: number;
  expiresAt: number;
}

function epoch(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * The caller's live session, or null.
 *
 * Expiry is judged against this process's clock here and again in the database
 * when the session starts; a session that has run out simply stops covering
 * messages, which is why a missed cleanup cannot give away an extra minute.
 */
export async function readHourSession(
  authorization: string | null,
  uid: string
): Promise<ActiveHourSession | null> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return null;

  try {
    const { data, error } = await client
      .from("hour_sessions")
      .select("chat_id, model, price, started_at, expires_at, ended_at")
      .eq("owner", uid)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as Record<string, unknown>;
    if (row.ended_at) return null;
    const expiresAt = epoch(row.expires_at);
    if (!expiresAt || expiresAt <= Date.now()) return null;
    if (typeof row.chat_id !== "string" || !row.chat_id) return null;

    return {
      chatId: row.chat_id,
      model: typeof row.model === "string" ? row.model : "flash",
      price: Math.max(0, Number(row.price) || 0),
      startedAt: epoch(row.started_at),
      expiresAt,
    };
  } catch {
    return null;
  }
}

/** The caller's live session when it belongs to `chatId`; otherwise null. */
export async function readHourSessionForChat(
  authorization: string | null,
  uid: string,
  chatId: string
): Promise<ActiveHourSession | null> {
  const session = await readHourSession(authorization, uid);
  return session && session.chatId === chatId ? session : null;
}
