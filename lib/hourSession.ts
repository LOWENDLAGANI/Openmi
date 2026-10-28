// ── The hour that covers everything (server only) ───────────────────────────
//
// The row is written by `start_hour_session()` and read here with the caller's
// own token. Nothing in this module decides whether an hour may start: that is
// the database function's job, because the only safe place for "one live hour per
// account" is beside the primary key that enforces it. This module answers the
// one question the routes ask before they answer:
//
//   does this account have a live hour right now?
//
// The hour is the account's, not the chat's: it covers every answer in every chat
// and on every model, which is why a request needs no other price.
//
// A read that fails is "no session", never "free answers". The direction a
// billing bug should err in is refusing one more message, not giving away an
// hour of them.

import { clientForToken } from "./supabase";

export interface ActiveHourSession {
  /** What the hour cost when it started; recorded, never charged again. */
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
 * The caller's live hour, or null.
 *
 * Expiry is judged against this process's clock here and again in the database
 * when the next hour starts; an hour that has run out simply stops covering
 * requests, so a missed cleanup cannot give away an extra minute.
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
      .select("price, started_at, expires_at, ended_at")
      .eq("owner", uid)
      .maybeSingle();
    if (error || !data) return null;

    const row = data as Record<string, unknown>;
    if (row.ended_at) return null;
    const expiresAt = epoch(row.expires_at);
    if (!expiresAt || expiresAt <= Date.now()) return null;

    return {
      price: Math.max(0, Number(row.price) || 0),
      startedAt: epoch(row.started_at),
      expiresAt,
    };
  } catch {
    return null;
  }
}
