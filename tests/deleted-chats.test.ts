// ── Openmi — tests for the deleted-chat list ────────────────────────────────
//
// The list exists twice over: a pull must not resurrect a chat somebody
// deleted, and a restore must not leave a chat permanently excluded from the
// account. Those are the same store read in opposite directions, which is
// exactly the kind of pair where one side gets forgotten.
//
//   bun run test

import assert from "node:assert/strict";
import {
  DELETED_KEY,
  MAX_DELETED,
  markDeleted,
  readDeletedIds,
  unmarkDeleted,
} from "../lib/deletedChats";

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
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** An in-memory localStorage stand-in, so nothing here needs a browser. */
function fakeStore(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string) => (key === DELETED_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === DELETED_KEY) value = next;
    },
    raw: () => value,
  };
}

console.log("deleted chats");

test("an id is remembered and read back", () => {
  const store = fakeStore();
  markDeleted(store, "chat-1");
  assert.deepEqual([...readDeletedIds(store)], ["chat-1"]);
});

test("deleting twice keeps one entry", () => {
  const store = fakeStore();
  markDeleted(store, "chat-1");
  markDeleted(store, "chat-1");
  assert.equal(readDeletedIds(store).size, 1);
});

test("restoring forgets the deletion, which is what lets it sync again", () => {
  const store = fakeStore();
  markDeleted(store, "chat-1");
  markDeleted(store, "chat-2");
  unmarkDeleted(store, "chat-1");
  assert.deepEqual([...readDeletedIds(store)], ["chat-2"]);
});

test("restoring something that was never deleted changes nothing", () => {
  const store = fakeStore();
  markDeleted(store, "chat-1");
  unmarkDeleted(store, "chat-9");
  assert.deepEqual([...readDeletedIds(store)], ["chat-1"]);
});

test("an unreadable or hostile value answers an empty list", () => {
  for (const raw of ["not json", "{}", "null", "\"chat-1\"", "[1, 2, 3]"]) {
    assert.equal(readDeletedIds(fakeStore(raw)).size, 0, `expected nothing for ${raw}`);
  }
  assert.equal(readDeletedIds(null).size, 0, "no storage is not a failure");
});

test("the list cannot grow without bound", () => {
  const store = fakeStore();
  for (let index = 0; index < MAX_DELETED + 25; index += 1) markDeleted(store, `chat-${index}`);
  const ids = readDeletedIds(store);
  assert.equal(ids.size, MAX_DELETED);
  // The newest deletions are the ones that still matter, so the oldest go.
  assert.equal(ids.has("chat-0"), false);
  assert.equal(ids.has(`chat-${MAX_DELETED + 24}`), true);
});

console.log(`\n${passes + failures} checks`);
if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("deleted-chats: all checks passed");
