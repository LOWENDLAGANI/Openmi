// ── Composer and thread regressions ──────────────────────────────────────────
//
// The bugs pinned here were all invisible to a build and to a type check, and
// each one made the app lie to the person using it:
//
//   - Enter while an answer streamed cancelled the answer being read, because
//     the composer's key handler went through the send path, and the send path
//     turns into Stop while a message is in flight.
//   - Pasting a screenshot raised "text and code files are supported", because
//     the same clipboard files were handed to the document reader as well as the
//     image one and the document reader had nothing it could read.
//   - A question made only of a document vanished from the thread on send: the
//     filter admitted text and images but not documents.
//
// They are components, so the checks are source contracts in the same style as
// tests/feature-batch.test.ts.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
let passes = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

async function main(): Promise<void> {
  console.log("\ncomposer and thread");

  await test("Enter during an answer belongs to the draft, not to Stop", () => {
    const input = read("components/ChatInput.tsx");
    const keyDown = input.slice(input.indexOf("const handleKeyDown"), input.indexOf("const addFilesByKind"));
    assert.ok(keyDown.length > 0, "the key handler moved; this contract needs rewriting");
    assert.match(keyDown, /if \(disabled\) return;/, "Enter while streaming still cancels the answer");
    assert.ok(
      keyDown.indexOf("if (disabled) return;") < keyDown.indexOf("handleSend()"),
      "the disabled guard has to stand in front of the send"
    );
  });

  await test("pasted or dropped files are split before they reach a reader", () => {
    const input = read("components/ChatInput.tsx");
    assert.match(input, /const addFilesByKind/, "there is no kind split");
    const split = input.slice(input.indexOf("const addFilesByKind"), input.indexOf("const handleDrop"));
    assert.match(split, /image\//, "images are not separated from documents");
    assert.match(split, /addFiles\(images\)/, "images never reach the image reader");
    assert.match(split, /addDocuments\(documents\)/, "documents never reach the document reader");
    assert.ok(
      !/addDocuments\(files\)/.test(input),
      "the whole clipboard is handed to the document reader again"
    );
  });

  await test("voice output is appended to what is in the box now", () => {
    const input = read("components/ChatInput.tsx");
    assert.match(input, /const textRef = useRef/, "there is no live text reference");
    assert.match(input, /const current = textRef\.current/, "dictation reads a stale draft");
  });

  await test("a question that is only a document stays in the thread", () => {
    const page = read("app/chat/page.tsx");
    const start = page.indexOf("const visibleMessages");
    const filter = page.slice(start, start + 400);
    assert.ok(start > 0, "the visible-message filter moved; this contract needs rewriting");
    assert.match(filter, /m\.documents\?\.length/, "a document-only question is filtered out of the thread");
  });

  await test("a dismissed proposal can be opened again", () => {
    const review = read("components/ChangeReview.tsx");
    assert.match(review, /Show the proposed change again/, "dismissing the review is a dead end");
    assert.match(review, /setDismissed\(false\)/, "the way back does not restore the card");
  });

  await test("a thinking model's reasoning is streamed and shown, and a silent one says nothing", () => {
    // The route already asked for reasoning effort and the chunk type already
    // named `reasoning_content`; the value was parsed and thrown away, so a
    // DeepSeek turn could think and the screen still showed only the conclusion.
    const route = read("app/api/chat/route.ts");
    assert.match(
      route,
      /delta\?\.reasoning_content \?\? chunk\.choices\?\.\[0\]\?\.delta\?\.reasoning/,
      "the reasoning is not read from both provider spellings"
    );
    assert.match(route, /encodeEvent\(\{ reasoning: thinking \}\)/, "the thinking never reaches the client");

    const page = read("app/chat/page.tsx");
    assert.match(page, /if \(evt\.reasoning\)/, "the client ignores the reasoning event");
    assert.match(page, /setThinking/, "the reasoning is never collected");
    assert.ok(
      !/patchMessage\(assistantMsg\.id, \{ reasoning/.test(page),
      "the model's scratchpad is being written into the stored message"
    );

    const thread = read("components/ChatThread.tsx");
    assert.match(thread, /function ThinkingBlock/, "there is no panel for the reasoning");
    assert.match(
      thread,
      /\{thinking\?\.messageId === msg\.id && <ThinkingBlock text=\{thinking\.text\} \/>\}/,
      "the panel is not attached to the message it belongs to"
    );
    assert.ok(thread.includes("thinking = null"), "the thread does not accept the reasoning");
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
