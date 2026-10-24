// Chats this device has deleted — deleted ids that a pull must not resurrect.

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

/** Forgets a deletion, which is what restoring a chat from the trash means. */
export function unmarkDeleted(store: KeyValueStore | null, chatId: string): Set<string> {
  const ids = readDeletedIds(store);
  if (ids.delete(chatId)) write(store, ids);
  return ids;
}
