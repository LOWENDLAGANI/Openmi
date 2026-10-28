// ── Openmi — tests for how two devices' chat histories are merged ─────────────
//
// Chat history is written to the account so it follows the person to another
// browser, and it was failing at exactly that: the data was written correctly
// and then deliberately never read back, so signing in on a computer showed an
// empty list while the phone's conversations sat there unread.
//
// The fix makes the pull a **union**. That is the part worth pinning down,
// because the obvious alternative — remote replaces local — deletes a device's
// conversations on every visit, and it does so quietly, on the visit after the
// person worked.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRemoteChat, planChatMerge, planHandover } from "../lib/chatSync";
import type { Chat, ChatMessage } from "../lib/types";

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

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    chatId: "c1",
    role: "assistant",
    content: "hello",
    createdAt: 100,
    updatedAt: 100,
    ...over,
  };
}

function chat(over: Partial<Chat> = {}): Chat {
  return { id: "c1", title: "A chat", createdAt: 100, updatedAt: 100, ...over };
}

console.log("\nwhose history this browser holds");

test("this account's own cache is kept", () => {
  assert.equal(planHandover({ storedOwner: "a", uid: "a", hasLocalHistory: true }), "keep");
});

test("an untouched browser simply adopts the account", () => {
  assert.equal(planHandover({ storedOwner: null, uid: "a", hasLocalHistory: false }), "claim");
});

test("a different account starts from an empty device", () => {
  assert.equal(planHandover({ storedOwner: "a", uid: "b", hasLocalHistory: true }), "switch");
  assert.equal(planHandover({ storedOwner: "a", uid: "b", hasLocalHistory: false }), "switch");
});

test("a cache with no remembered owner counts as somebody else's", () => {
  // The state of every browser that existed before this rule. Assuming it is
  // the signing-in account's is how the leak happened in the first place.
  assert.equal(planHandover({ storedOwner: null, uid: "a", hasLocalHistory: true }), "switch");
});

test("nothing reaches the account until the device belongs to it", () => {
  const source = readFileSync(join(process.cwd(), "lib/cloudHistory.ts"), "utf8");
  const push = source.slice(source.indexOf("export async function syncCloudHistory"));
  const beforeUpload = push.slice(0, push.indexOf("for (const chat of uploadable)"));
  assert.match(beforeUpload, /deviceBelongsTo\(uid\)/, "the bulk push must check the device owner");

  const page = readFileSync(join(process.cwd(), "app/chat/page.tsx"), "utf8");
  assert.match(page, /adoptDeviceAccount/, "signing in must hand the device over");
});

test("signing out leaves none of the previous session on screen", () => {
  const page = readFileSync(join(process.cwd(), "app/chat/page.tsx"), "utf8");
  const start = page.indexOf("if (account?.signedIn !== false) return;");
  assert.ok(start > 0, "the sign-out effect must exist");
  const block = page.slice(start, page.indexOf("}, [account?.signedIn", start));
  assert.match(block, /endTemporary\(\)/, "an open temporary thread must not survive the session");
  assert.match(block, /setActiveChatId\(null\)/);
  assert.match(block, /setProject\(null\)/, "the repository chip named the previous account's repository");
});

console.log("\na chat this browser has never seen");

test("is added whole, messages and all", () => {
  const remote = { chat: chat(), messages: [message(), message({ id: "m2", role: "user" })] };
  const merge = planChatMerge(remote, undefined, []);
  assert.equal(merge.addChat, true);
  assert.equal(merge.chatUpdate, null);
  assert.equal(merge.addMessages.length, 2);
  assert.equal(merge.updateMessages.length, 0);
});

console.log("\na chat both devices have");

test("adds only the messages this browser is missing", () => {
  // The phone wrote m1 and m2; this computer has only m1 because it is a
  // different conversation about the same chat.
  const remote = { chat: chat(), messages: [message(), message({ id: "m2", createdAt: 200 })] };
  const merge = planChatMerge(remote, chat(), [message()]);
  assert.equal(merge.addChat, false);
  assert.deepEqual(merge.addMessages.map((m) => m.id), ["m2"]);
  assert.equal(merge.updateMessages.length, 0);
});

test("does not rewrite a message that is already current", () => {
  const remote = { chat: chat({ updatedAt: 500 }), messages: [message({ content: "stale", updatedAt: 100 })] };
  const merge = planChatMerge(remote, chat({ updatedAt: 900 }), [message({ content: "current", updatedAt: 900 })]);
  assert.equal(merge.updateMessages.length, 0);
  assert.equal(merge.chatUpdate, null);
});

test("takes the newer copy of a message that changed elsewhere", () => {
  const remote = { chat: chat({ updatedAt: 500 }), messages: [message({ content: "finished on the phone", updatedAt: 800 })] };
  const merge = planChatMerge(remote, chat({ updatedAt: 500 }), [message({ content: "half a sen", updatedAt: 300 })]);
  assert.equal(merge.addMessages.length, 0);
  assert.equal(merge.updateMessages.length, 1);
  assert.equal(merge.updateMessages[0].changes.content, "finished on the phone");
});

test("an equal timestamp is not a reason to overwrite", () => {
  const remote = { chat: chat({ updatedAt: 500 }), messages: [message({ content: "theirs", updatedAt: 500 })] };
  const merge = planChatMerge(remote, chat({ updatedAt: 500 }), [message({ content: "mine", updatedAt: 500 })]);
  assert.equal(merge.updateMessages.length, 0);
});

test("keeps the attachments the upload never carried", () => {
  // Images, documents and generated images stay local. An overwrite that listed
  // every field would replace a message holding a photo with one that has none,
  // and the photo would be gone with nothing to get it back from.
  const local = message({
    content: "look at this",
    updatedAt: 300,
    images: [{ url: "data:image/jpeg;base64,AAA", name: "photo.jpg", size: 10 }],
    generatedImages: [
      { url: "data:image/png;base64,BBB", prompt: "a cat", mime: "image/png", model: "Openmi Canvas", createdAt: 300 },
    ],
  });
  const remote = { chat: chat({ updatedAt: 500 }), messages: [message({ content: "look at this", updatedAt: 800 })] };
  const merge = planChatMerge(remote, chat({ updatedAt: 500 }), [local]);
  const changes = merge.updateMessages[0].changes;
  assert.ok(changes, "the newer remote copy should be adopted");
  assert.equal(changes.images, undefined);
  assert.equal(changes.generatedImages, undefined);
  assert.equal(changes.documents, undefined);
});

console.log("\nthe parts of an answer that are not its text");

test("the agent's reads, review card, variants and truncation survive a pull", () => {
  // These are the difference between an answer another device can act on and
  // one that merely reads well: a proposal with no review card can never be
  // committed, and a cut-off answer shown clean looks finished.
  const parsed = parseRemoteChat({
    id: "c1",
    messages: {
      a: {
        id: "m1",
        role: "assistant",
        content: "done",
        createdAt: 1,
        steps: [{ tool: "read_file", label: "Read src/a.ts", ok: true }],
        changesetId: "0123456789abcdefabcd",
        truncated: true,
        variants: ["the earlier answer"],
        variantIndex: 1,
      },
    },
  });
  assert.ok(parsed);
  const stored = parsed.messages[0]!;
  assert.deepEqual(stored.steps, [{ tool: "read_file", label: "Read src/a.ts", ok: true }]);
  assert.equal(stored.changesetId, "0123456789abcdefabcd");
  assert.equal(stored.truncated, true);
  assert.deepEqual(stored.variants, ["the earlier answer"]);
  assert.equal(stored.variantIndex, 1);
});

test("a malformed step, change-set id or variant index is dropped", () => {
  const parsed = parseRemoteChat({
    id: "c1",
    messages: {
      a: {
        id: "m1",
        role: "assistant",
        content: "done",
        createdAt: 1,
        steps: [
          { tool: "steal_token", label: "pretend", ok: true },
          { tool: "read_file", label: 42, ok: true },
          { tool: "read_file", label: "Read src/a.ts", ok: false },
        ],
        changesetId: "not-an-id",
        variants: ["only one", 42],
        variantIndex: 5,
      },
    },
  });
  assert.ok(parsed);
  const stored = parsed.messages[0]!;
  assert.deepEqual(stored.steps, [{ tool: "read_file", label: "Read src/a.ts", ok: false }]);
  assert.equal(stored.changesetId, undefined);
  assert.deepEqual(stored.variants, ["only one"]);
  assert.equal(stored.variantIndex, undefined, "an index past the variants is refused");
});

test("a newer copy without those fields does not erase the local ones", () => {
  // A message uploaded by an older client carries none of them; writing
  // `undefined` would delete this browser's review card and step timeline.
  const local = message({
    content: "old",
    updatedAt: 100,
    steps: [{ tool: "read_file", label: "Read src/a.ts", ok: true }],
    changesetId: "0123456789abcdefabcd",
    variants: ["earlier"],
  });
  const remote = { chat: chat({ updatedAt: 500 }), messages: [message({ content: "new", updatedAt: 800 })] };
  const merge = planChatMerge(remote, chat({ updatedAt: 500 }), [local]);
  const changes = merge.updateMessages[0]!.changes;
  assert.equal(changes.content, "new");
  assert.equal(changes.steps, undefined);
  assert.equal(changes.changesetId, undefined);
  assert.equal(changes.variants, undefined);
});

console.log("\nchat metadata");

test("a rename made elsewhere is adopted", () => {
  const remote = { chat: chat({ title: "Renamed on the phone", updatedAt: 900 }), messages: [] };
  const merge = planChatMerge(remote, chat({ title: "Old title", updatedAt: 400 }), []);
  assert.equal(merge.addChat, false);
  assert.equal(merge.chatUpdate?.title, "Renamed on the phone");
});

test("an unpin elsewhere is honoured, not undone", () => {
  const remote = { chat: chat({ pinned: false, updatedAt: 900 }), messages: [] };
  const merge = planChatMerge(remote, chat({ pinned: true, updatedAt: 400 }), []);
  assert.equal(merge.chatUpdate?.pinned, false);
});

console.log("\nanything read off the network is untrusted");

test("a node without an id is dropped", () => {
  assert.equal(parseRemoteChat(null), null);
  assert.equal(parseRemoteChat("nope"), null);
  assert.equal(parseRemoteChat({ title: "no id here" }), null);
  assert.equal(parseRemoteChat({ id: "" }), null);
});

test("missing timestamps and a missing title do not break it", () => {
  const parsed = parseRemoteChat({ id: "c9", messages: { a: { id: "m9", role: "assistant", content: "hi" } } });
  assert.ok(parsed);
  assert.equal(parsed.chat.title, "New chat");
  assert.equal(parsed.chat.updatedAt, 0);
  assert.equal(parsed.messages[0].createdAt, 0);
});

test("a message the interface cannot render is dropped, not stored", () => {
  const parsed = parseRemoteChat({
    id: "c9",
    messages: {
      good: { id: "m1", role: "user", content: "hi", createdAt: 1 },
      wrongRole: { id: "m2", role: "system", content: "be nice", createdAt: 2 },
      noId: { role: "assistant", content: "orphan", createdAt: 3 },
    },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.messages.map((m) => m.id), ["m1"]);
});

test("a message's chat is taken from the chat it arrived under", () => {
  // The stored chatId cannot be trusted, and getting it wrong files a message
  // into a thread that does not exist — invisible, and unreadable ever again.
  const parsed = parseRemoteChat({
    id: "c-real",
    messages: { a: { id: "m1", role: "user", content: "hi", chatId: "someone-elses", createdAt: 1 } },
  });
  assert.ok(parsed);
  assert.equal(parsed.messages[0].chatId, "c-real");
});

test("a non-array sources value is discarded rather than stored", () => {
  const parsed = parseRemoteChat({
    id: "c9",
    messages: { a: { id: "m1", role: "assistant", content: "hi", sources: "not a list", createdAt: 1 } },
  });
  assert.ok(parsed);
  assert.equal(parsed.messages[0].sources, undefined);
});

console.log(
  failures === 0
    ? `\n${passes} passed\n`
    : `\n${passes} passed, ${failures} FAILED\n`
);
process.exit(failures === 0 ? 0 : 1);