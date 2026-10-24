// ── Folders this device has deleted ──────────────────────────────────────────
//
// Folder deletion is soft in the database, but a device still needs to remember
// its own intent before the write lands: a pull that arrives between the local
// delete and the remote update would otherwise see the folder as active and add
// it straight back. The list lives in localStorage for the same reason the chat
// tombstones do — it has to survive the database it is guarding.
//
// A tombstone is cleared once the soft delete has been accepted. Resurrecting a
// deleted folder is prevented on the server by not sending `deleted_at` in an
// active upsert, so the tombstone is only a short-lived safety net rather than
// the permanent record.
//
// Pure logic with an injectable store, so both directions can be tested without
// a browser.

import type { KeyValueStore } from "./deletedChats";

export const DELETED_FOLDERS_KEY = "openmi:deleted-folders";

/** The most ids kept. A folder list is small; this is generous. */
export const MAX_DELETED_FOLDERS = 200;

/** Every folder id this device has deleted, from the stored JSON. */
export function readDeletedFolderIds(store: KeyValueStore | null): Set<string> {
  if (!store) return new Set();
  try {
    const raw = store.getItem(DELETED_FOLDERS_KEY);
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
    store.setItem(DELETED_FOLDERS_KEY, JSON.stringify([...ids].slice(-MAX_DELETED_FOLDERS)));
  } catch {
    // Storage unavailable: the local deletion is still local and still correct.
  }
}

/** Records a folder deletion and returns the resulting set. */
export function markFolderDeleted(store: KeyValueStore | null, folderId: string): Set<string> {
  const ids = readDeletedFolderIds(store);
  ids.add(folderId);
  write(store, ids);
  return ids;
}

/** Forgets a deletion once the account has accepted the soft delete. */
export function unmarkFolderDeleted(store: KeyValueStore | null, folderId: string): Set<string> {
  const ids = readDeletedFolderIds(store);
  if (ids.delete(folderId)) write(store, ids);
  return ids;
}
