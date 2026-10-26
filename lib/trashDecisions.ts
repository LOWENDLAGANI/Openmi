// ── Trash decisions this device has made but not yet delivered ───────────────
//
// Restoring a chat or deleting one for ever is a decision about the account's
// trash, and it can be made while the network is down. Without a record of it,
// the next pull would simply re-add the chat from the account's copy — the
// person restores a conversation on a plane and finds it back in the trash when
// they land.
//
// So each decision is remembered here until the account has accepted it. A
// restore is delivered by uploading the chat first and then closing its trash
// row; a permanent delete is delivered by closing the row alone. The distinction
// matters because another device reads "closed with no live chat" as deleted.
//
// Kept in localStorage, like the chat and folder tombstones, so it survives the
// database the decision is waiting to be written to.

import type { KeyValueStore } from "./deletedChats";

export const TRASH_DECISIONS_KEY = "openmi:trash-decisions";

/** What the person decided about one chat in the trash. */
export type TrashDecision = "restore" | "purge";

/** The most decisions kept. Generous for a thirty-day holding pen. */
export const MAX_TRASH_DECISIONS = 200;

/** Every undelivered decision, by chat id. */
export function readTrashDecisions(store: KeyValueStore | null): Map<string, TrashDecision> {
  const decisions = new Map<string, TrashDecision>();
  if (!store) return decisions;
  try {
    const raw = store.getItem(TRASH_DECISIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return decisions;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === "restore" || value === "purge") decisions.set(id, value);
    }
  } catch {
    // Unreadable storage means no pending decisions, which is the safe default:
    // the account's copy is authoritative until a decision is recorded again.
  }
  return decisions;
}

function write(store: KeyValueStore | null, decisions: Map<string, TrashDecision>): void {
  if (!store) return;
  try {
    const entries = [...decisions.entries()].slice(-MAX_TRASH_DECISIONS);
    store.setItem(TRASH_DECISIONS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Storage unavailable: the local change still stands, it just cannot be
    // replayed after a reload.
  }
}

/** Records a decision and returns the resulting map. */
export function markTrashDecision(
  store: KeyValueStore | null,
  chatId: string,
  decision: TrashDecision
): Map<string, TrashDecision> {
  const decisions = readTrashDecisions(store);
  decisions.set(chatId, decision);
  write(store, decisions);
  return decisions;
}

/** Forgets a decision once the account has accepted it. */
export function clearTrashDecision(
  store: KeyValueStore | null,
  chatId: string
): Map<string, TrashDecision> {
  const decisions = readTrashDecisions(store);
  if (decisions.delete(chatId)) write(store, decisions);
  return decisions;
}

/**
 * Forgets every decision, for a browser that is changing hands.
 *
 * A pending "purge this chat" belongs to the account that recorded it. Left in
 * place, the next account's sign-in would deliver it against its own trash,
 * where the id means nothing at best and somebody else's chat at worst.
 */
export function clearTrashDecisions(store: KeyValueStore | null): void {
  write(store, new Map());
}
