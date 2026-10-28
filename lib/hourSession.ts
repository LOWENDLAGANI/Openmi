// ── The hour that covers one model and one repository (server only) ─────────
//
// The row is written by `start_hour_session()` and read here with the caller's
// own token. Nothing in this module decides whether an hour may start: that is
// the database function's job, because the only safe place for "one live hour per
// account" is beside the primary key that enforces it. This module answers the
// one question the routes ask before they answer:
//
//   does this account have a live hour right now, and does it cover this request?
//
// The hour is the account's, but it is bought for one thing: the model the buyer
// picked, and — when it was started from the repository agent — the one
// repository it was started on. Chat and the agent draw on the same hour, so an
// hour bought for DeepSeek answers DeepSeek and an hour bought on one repository
// is refused on another. Changing either is a new purchase, not a toggle, which
// is why the refusals below name the active model or repository and then offer
// the two honest choices: keep using it, or end the hour.
//
// A read that fails is "no session", never "free answers". The direction a
// billing bug should err in is refusing one more message, not giving away an
// hour of them.

import { clientForToken } from "./supabase";
import { getMode, type ModeId } from "./models";

export interface ActiveHourSession {
  /** What the hour cost when it started; recorded, never charged again. */
  price: number;
  startedAt: number;
  expiresAt: number;
  /** The one model this hour was bought for. */
  model: ModeId;
  /** The one repository it was bought for, or null for ordinary chat. */
  projectId: string | null;
  /** The repository's `owner/name`, kept beside the id so a refusal can name it. */
  repoFullName: string | null;
}

function epoch(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** The stored model, narrowed to a mode the product still offers. */
export function normalizeHourModel(value: unknown): ModeId {
  return value === "code" || value === "flash" ? value : "auto";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
      .select("price, started_at, expires_at, ended_at, model, project_id, repo_full_name")
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
      model: normalizeHourModel(row.model),
      projectId: text(row.project_id),
      repoFullName: text(row.repo_full_name),
    };
  } catch {
    return null;
  }
}

/** "DeepSeek V4.1 Flash" — the product name for the hour's model. */
export function hourModelLabel(session: ActiveHourSession): string {
  return getMode(session.model).display;
}

/**
 * The refusal a request gets when it asks a model the hour was not bought for.
 *
 * One sentence says what is happening, and one says what to do about it. Both
 * choices are named because both exist: keep using the active model, or end the
 * hour and buy a new one for the model just picked.
 */
export function hourModelRefusal(session: ActiveHourSession, requested: ModeId | string): string {
  const active = hourModelLabel(session);
  const asked = getMode(requested).display;
  return `**Your hour is for ${active}.** An hour session is bought for one model, so ${asked} cannot answer on it. Continue with ${active}, or end the hour session and start a new one for ${asked}.`;
}

/**
 * The refusal the repository agent gets for the wrong repository.
 *
 * An hour started without a repository does not cover the agent at all, so that
 * case is said plainly rather than as "a different repository".
 */
export function hourRepoRefusal(session: ActiveHourSession, requestedRepo: string): string {
  if (!session.projectId) {
    return `**Your hour is not for the repository agent.** This hour was started without a repository, so it cannot cover work on ${requestedRepo}. Continue in ordinary chat, or end the hour session and start a new one with ${requestedRepo} attached.`;
  }
  const active = session.repoFullName ?? "the repository it started on";
  return `**Your hour is for ${active}.** An hour session is bought for one repository, so ${requestedRepo} cannot use it. Continue with ${active}, or end the hour session and start a new one for ${requestedRepo}.`;
}
