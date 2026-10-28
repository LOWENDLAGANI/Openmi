// ── Openmi — tests for a sidebar that follows the account ────────────────────
//
// Folders and the trash used to be this browser's business alone. Now that the
// product requires an account, they are part of the same promise the chats
// make: file a conversation under "Work" on a phone and it is under "Work" on
// the computer, delete it on either and it leaves both lists, and the trash on
// one device can put back what the other deleted.
//
// The quiet failures are the ones pinned here:
//
//   • a deletion that only reached this device, so the folder comes back on the
//     next pull and the person deletes it again, and again;
//   • a restore made while offline that the next sign-in quietly undoes by
//     re-adding the account's trash row;
//   • "delete forever" that comes back because another device uploaded its own
//     copy of the trash;
//   • a folder id remembered by a chat after the folder itself is gone.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DELETED_FOLDERS_KEY,
  MAX_DELETED_FOLDERS,
  markFolderDeleted,
  readDeletedFolderIds,
  unmarkFolderDeleted,
} from "../lib/deletedFolders";
import {
  clearTrashDecision,
  markTrashDecision,
  readTrashDecisions,
  TRASH_DECISIONS_KEY,
} from "../lib/trashDecisions";
import { planChatMerge } from "../lib/chatSync";
import type { Chat } from "../lib/types";

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

/** An in-memory localStorage stand-in, so nothing here needs a browser. */
function fakeStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    raw: (key: string) => values.get(key) ?? null,
  };
}

/** Source with comments removed, so a comment cannot satisfy a check. */
function code(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function chat(over: Partial<Chat> = {}): Chat {
  return { id: "c1", title: "A chat", createdAt: 100, updatedAt: 100, ...over };
}

console.log("\nfolder deletions");

test("a deleted folder id is remembered and read back", () => {
  const store = fakeStore();
  markFolderDeleted(store, "folder-1");
  assert.deepEqual([...readDeletedFolderIds(store)], ["folder-1"]);
  assert.match(store.raw(DELETED_FOLDERS_KEY) ?? "", /folder-1/);
});

test("deleting the same folder twice keeps one entry", () => {
  const store = fakeStore();
  markFolderDeleted(store, "folder-1");
  markFolderDeleted(store, "folder-1");
  assert.equal(readDeletedFolderIds(store).size, 1);
});

test("an accepted soft delete clears the tombstone", () => {
  const store = fakeStore();
  markFolderDeleted(store, "folder-1");
  unmarkFolderDeleted(store, "folder-1");
  assert.equal(readDeletedFolderIds(store).size, 0);
});

test("unreadable storage is an empty set, never a crash", () => {
  const store = fakeStore();
  store.setItem(DELETED_FOLDERS_KEY, "not json");
  assert.equal(readDeletedFolderIds(store).size, 0);
  assert.equal(readDeletedFolderIds(null).size, 0);
});

test("the tombstone list cannot grow without bound", () => {
  const store = fakeStore();
  for (let index = 0; index < MAX_DELETED_FOLDERS + 10; index += 1) {
    markFolderDeleted(store, `folder-${index}`);
  }
  const ids = readDeletedFolderIds(store);
  assert.equal(ids.size, MAX_DELETED_FOLDERS);
  assert.equal(ids.has("folder-0"), false);
});

console.log("\ntrash decisions made offline");

test("a restore waits for delivery", () => {
  const store = fakeStore();
  markTrashDecision(store, "chat-1", "restore");
  assert.equal(readTrashDecisions(store).get("chat-1"), "restore");
  assert.match(store.raw(TRASH_DECISIONS_KEY) ?? "", /restore/);
});

test("a permanent delete waits for delivery", () => {
  const store = fakeStore();
  markTrashDecision(store, "chat-1", "purge");
  assert.equal(readTrashDecisions(store).get("chat-1"), "purge");
});

test("the last decision for a chat wins", () => {
  const store = fakeStore();
  markTrashDecision(store, "chat-1", "restore");
  markTrashDecision(store, "chat-1", "purge");
  assert.equal(readTrashDecisions(store).size, 1);
  assert.equal(readTrashDecisions(store).get("chat-1"), "purge");
});

test("an accepted decision is forgotten", () => {
  const store = fakeStore();
  markTrashDecision(store, "chat-1", "restore");
  clearTrashDecision(store, "chat-1");
  assert.equal(readTrashDecisions(store).size, 0);
});

test("only real decisions are read, whatever is in storage", () => {
  const store = fakeStore();
  store.setItem(TRASH_DECISIONS_KEY, JSON.stringify({ a: "restore", b: "purge", c: "sideways", d: 3 }));
  const decisions = readTrashDecisions(store);
  assert.deepEqual([...decisions.keys()].sort(), ["a", "b"]);
  assert.equal(readTrashDecisions(null).size, 0);
});

console.log("\nfiling a chat on another device");

test("a folder assignment crosses devices without a new message", () => {
  const remote = { chat: chat({ folder: "work", updatedAt: 100 }), messages: [] };
  const merge = planChatMerge(remote, chat({ folder: undefined, updatedAt: 100 }), []);
  assert.deepEqual(merge.chatUpdate, { folder: "work" });
  assert.equal(merge.addChat, false);
});

test("unfiling travels too, because it is the same fact", () => {
  const remote = { chat: chat({ updatedAt: 100 }), messages: [] };
  const merge = planChatMerge(remote, chat({ folder: "work", updatedAt: 100 }), []);
  assert.equal(merge.chatUpdate?.folder, undefined);
});

test("a chat already in the right folder is not rewritten", () => {
  const remote = { chat: chat({ folder: "work", updatedAt: 100 }), messages: [] };
  const merge = planChatMerge(remote, chat({ folder: "work", updatedAt: 100 }), []);
  assert.equal(merge.chatUpdate, null);
});

console.log("\nthe code that delivers it");

const cloudHistory = code("lib/cloudHistory.ts");
const sidebar = code("components/Sidebar.tsx");
const trashOverlay = code("components/TrashOverlay.tsx");
const page = code("app/chat/page.tsx");
const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20261024000100_folders_trash.sql"),
  "utf8"
);

test("folder deletions are soft, so a stale device cannot reopen one", () => {
  assert.match(migration, /create table if not exists public\.folders/i);
  assert.match(migration, /deleted_at timestamptz/);
  assert.doesNotMatch(
    code("lib/cloudHistory.ts").match(/function folderRow[\s\S]*?\n}/)?.[0] ?? "",
    /deleted_at/,
    "an active folder upsert must not clear a soft delete"
  );
  assert.match(cloudHistory, /\.update\(\{ deleted_at: new Date\(\)\.toISOString\(\) \}\)/);
});

test("the trash keeps the whole thread, and its row outlives the decision", () => {
  assert.match(migration, /create table if not exists public\.trash/i);
  assert.match(migration, /messages jsonb/);
  assert.match(migration, /purged_at timestamptz/);
  const row = cloudHistory.match(/function trashRow[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(row, /messages: entry\.messages/, "the snapshot must carry the messages");
  const put = cloudHistory.match(/export async function syncTrashPut[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(put, /\.from\("trash"\)/, "the trash row is written");
});

test("both new tables are owner-scoped by row-level security", () => {
  for (const table of ["folders", "trash"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`create policy ${table}_owner on public\\.${table}`));
  }
  assert.match(migration, /owner = auth\.uid\(\)/);
});

test("a chat's folder is stored beside it", () => {
  assert.match(migration, /alter table public\.chats add column if not exists folder_id text/);
  assert.match(cloudHistory, /folder_id: chat\.folder \?\? null/);
  assert.match(cloudHistory, /folder: row\.folder_id/);
});

test("creating and filing reach the account", () => {
  assert.match(sidebar, /syncFolderUp\(folder\)/);
  assert.match(sidebar, /syncChatFolder\(chatId, folderId\)/);
});

test("deleting a folder takes it away everywhere and unfiles its chats", () => {
  const remove = sidebar.match(/const removeFolder = async[\s\S]*?\n  };/)?.[0] ?? "";
  assert.match(remove, /markFolderDeleted\(/);
  assert.match(remove, /syncFolderDelete\(id\)/);
  assert.match(remove, /syncChatFolder\(chatId, undefined\)/);
});

test("deleting a chat puts the same snapshot in the account's trash", () => {
  const remove = sidebar.match(/const handleDeleteChat =[\s\S]*?\n  };/)?.[0] ?? "";
  assert.match(remove, /moveChatToTrash\(chatId\)\.then/);
  assert.match(remove, /syncTrashPut\(entry\)/);
});

test("restore and delete-forever are recorded before they are delivered", () => {
  assert.match(trashOverlay, /markTrashDecision\(entry\.id, "restore"\)/);
  assert.match(trashOverlay, /markTrashDecision\(entry\.id, "purge"\)/);
  assert.match(trashOverlay, /syncTrashRemove\(entry\.id\)/);
  assert.doesNotMatch(trashOverlay, /Kept on this device only/, "the copy still says device-local");
});

test("signing in delivers offline decisions before the pull can undo them", () => {
  const syncBlock = page.match(/await flushTrashDecisions[\s\S]*?await syncLocalTrash/)?.[0] ?? "";
  assert.ok(syncBlock, "the account sync block is missing");
  const flushAt = syncBlock.indexOf("flushTrashDecisions");
  const trashAt = syncBlock.indexOf("loadTrashFromAccount");
  const chatsAt = syncBlock.indexOf("loadChatsFromAccount");
  assert.ok(flushAt >= 0 && trashAt > flushAt, "decisions must precede the trash pull");
  assert.ok(chatsAt > trashAt, "the trash pull must precede the live chat pull");
});

test("a purged row is never reopened by a stale local copy", () => {
  const sync = cloudHistory.match(/export async function syncLocalTrash[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(sync, /purged_at/);
  assert.match(sync, /db\.trash\.delete\(entry\.id\)/);
});

test("the app pulls folders and trash on sign-in and pushes its own", () => {
  for (const call of [
    "loadFoldersFromAccount()",
    "loadTrashFromAccount()",
    "syncFoldersToAccount()",
    "syncLocalTrash()",
  ]) {
    assert.ok(page.includes(call), `${call} is not called`);
  }
});

test("clearing everything clears the sidebar in the account too", () => {
  const wipe = cloudHistory.match(/export async function syncChatWipe[\s\S]*?\n}/)?.[0] ?? "";
  assert.match(wipe, /from\("folders"\)\.update\(\{ deleted_at/);
  assert.match(wipe, /from\("trash"\)\.update\(\{ purged_at/);
});

console.log(`\n${passes + failures} checks`);
if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("folders-trash: all checks passed");
