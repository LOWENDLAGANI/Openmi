// ── Which account this browser's copy of the history belongs to ─────────────
//
// The local database is one database, not one per account. That is fine while a
// device has exactly one person on it, and wrong the moment it has two: the
// second person signed in and the sidebar offered the first person's
// conversations, while the debounced push uploaded them into the second
// account. The account id is written down here so the handover can be explicit
// instead of accidental.
//
// The rules live in `planHandover` (lib/chatSync.ts) because they are pure and
// testable; this module is the part that touches storage and Dexie.
//
// `adoptDeviceAccount` is safe to call from several effects: one promise per
// account, resolved once. It is deliberately not called on sign-out — the gate
// shows the sign-in screen, and the same person signing back in keeps their
// cache instead of re-downloading it — so the wipe happens when a *different*
// account claims the browser, before anything of theirs is pulled or pushed.

import { planHandover, type DeviceHandover } from "./chatSync";
import { clearAllData, db } from "./db";
import { localStorageOrNull } from "./deletedChats";
import { clearTrashDecisions } from "./trashDecisions";

/** Where the account that owns this browser's history is remembered. */
export const DEVICE_OWNER_KEY = "openmi:device-owner";

function storedOwner(): string | null {
  const store = localStorageOrNull();
  if (!store) return null;
  try {
    const value = store.getItem(DEVICE_OWNER_KEY);
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function rememberOwner(uid: string): void {
  const store = localStorageOrNull();
  if (!store) return;
  try {
    store.setItem(DEVICE_OWNER_KEY, uid);
  } catch {
    // A browser that refuses storage cannot remember the owner, and the next
    // sign-in clears the cache again. Losing the shortcut is not losing data.
  }
}

/**
 * True when this browser's history is known to belong to `uid`.
 *
 * Two sources, because they cover different moments: the id on disk survives a
 * reload, and the adoption in this page covers a browser that refuses storage
 * (where the id can never be written). During a handover the answer is false
 * even for the account being adopted — the wipe has not finished, and the push
 * must not read the rows that are about to go.
 */
export function deviceBelongsTo(uid: string): boolean {
  if (!uid) return false;
  if (current?.uid === uid) return readyFor === uid;
  return storedOwner() === uid;
}

/**
 * Whether anything worth clearing is stored here.
 *
 * Chats are what the sidebar shows, but a folder or a trash entry is just as
 * much the previous account's data, and a leftover folder would appear in the
 * new account's sidebar.
 */
async function hasLocalHistory(): Promise<boolean> {
  const [chats, messages, folders, trash] = await Promise.all([
    db.chats.count(),
    db.messages.count(),
    db.folders.count(),
    db.trash.count(),
  ]);
  return chats + messages + folders + trash > 0;
}

let current: { uid: string; done: Promise<DeviceHandover> } | null = null;
/** The account this page has finished handing the device to, if any. */
let readyFor: string | null = null;

/**
 * Hands this browser's stored history to the account that is signed in.
 *
 * Resolves with what happened. `switch` means the previous account's chats,
 * messages, folders, trash and undelivered trash decisions are gone before the
 * caller pulls this account's history; `keep` means nothing was touched.
 *
 * A failure is not remembered, so the next call tries again rather than
 * replaying a rejection. On failure the caller must not treat the device as
 * adopted: the stale rows are still there.
 */
export function adoptDeviceAccount(uid: string): Promise<DeviceHandover> {
  if (!uid) return Promise.resolve("switch");
  if (current?.uid === uid) return current.done;

  // A new handover starts unadopted: anything that asks "does this device hold
  // this account?" while the wipe is running has to hear no.
  readyFor = null;

  const done = (async (): Promise<DeviceHandover> => {
    const handover = planHandover({
      storedOwner: storedOwner(),
      uid,
      hasLocalHistory: await hasLocalHistory(),
    });
    if (handover === "switch") {
      // The rows go first. A decision recorded for the previous account's trash
      // would otherwise be delivered to this one, and a chat with no owner is
      // worse than an empty list.
      await clearAllData();
      clearTrashDecisions(localStorageOrNull());
    }
    rememberOwner(uid);
    return handover;
  })();

  current = { uid, done };
  void done.then(
    () => {
      readyFor = uid;
    },
    () => {
      // A refused handover is not remembered, so the next call tries again
      // instead of replaying the failure for the life of the page.
      if (current?.uid === uid) current = null;
    }
  );
  return done;
}
