// ── Chats this device has deleted ────────────────────────────────────────────
//
// A pull from the account must never resurrect a conversation somebody just
// deleted here, so the ids are recorded locally and honoured on the way in. The
// list is kept in localStorage rather than Dexie because it must survive the
// very database it is guarding.
//
// It is also the reason a *restore* needs a matching "unmark": a chat put back
// from the trash is a chat the person has decided they want again, and leaving
// its id on this list would silently exclude it from every later upload — it
// would exist on this browser and nowhere else, for ever, with no explanation.
//
// Pure logic with an injectable store, so both directions can be tested without
// a browser.

export const DELETED_KEY = "openmi:deleted-chats";

/** The most ids kept. Old enough entries cannot matter to a live chat. */
export const MAX_DELETED = 500;

/** The slice of localStorage this module needs. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's store, or null when there is no browser or it refuses. */
export function localStorageOrNull(): KeyValueStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Every id this device has deleted, from the stored JSON. */
export function readDeletedIds(store: KeyValueStore | null): Set<string> {
  if (!store) return new Set();
  try {
    const raw = store.getItem(DELETED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
    );
  } catch {
    return new Set();
  }
}

function write(store: KeyValueStore | null, ids: Set<string>): void {
  if (!store) return;
  try {
    store.setItem(DELETED_KEY, JSON.stringify([...ids].slice(-MAX_DELETED)));
  } catch {
    // Storage unavailable: the deletion is still local and still correct.
  }
}

/** Records a deletion and returns the resulting set. */
export function markDeleted(store: KeyValueStore | null, chatId: string): Set<string> {
  const ids = readDeletedIds(store);
  ids.add(chatId);
  write(store, ids);
  return ids;
}

/**
 * Forgets a deletion, which is what restoring a chat from the trash means.
 *
 * Returns the resulting set so the caller can act on it without another read.
 */
export function unmarkDeleted(store: KeyValueStore | null, chatId: string): Set<string> {
  const ids = readDeletedIds(store);
  if (ids.delete(chatId)) write(store, ids);
  return ids;
}
