// ── Tests for the shell's shared behaviour ───────────────────────────────────
//
// These are the pure parts: the parts that decide *whether* something expired,
// *how long* a wait is, and *what* the console counts. Each one can quietly lie
// in a way a screenshot never shows — a weekly count summed instead of unioned,
// a countdown that goes negative — so they are pinned here. A few source-level
// checks cover the wiring that connects them to the UI, in the same spirit as
// the model-health suite.
//
// The overhaul removed the send-later queue, read-aloud and the image gallery;
// their tests went with them rather than being left to pass against dead code.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRASH_RETENTION_MS, isTrashExpired } from "../lib/trash";
import { parseRetrySeconds, secondsRemaining } from "../lib/rateLimit";
import { summarizeUsage, type UsageDayInput } from "../lib/usageStats";

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
console.log("\nrate limit countdown");

await test("the server's own refusal is read as a number of seconds", () => {
  assert.equal(
    parseRetrySeconds("Too many messages at once. Please wait 12s and try again."),
    12
  );
  assert.equal(
    parseRetrySeconds("Too many requests at once. Please wait 45 s and try again."),
    45
  );
});

await test("an error with no wait in it starts no countdown", () => {
  assert.equal(parseRetrySeconds("Openmi is paused right now. Please try again shortly."), null);
  assert.equal(parseRetrySeconds(""), null);
  assert.equal(parseRetrySeconds("Please wait a moment"), null, "no number, no countdown");
});

await test("a nonsensical or enormous wait is refused or clamped", () => {
  assert.equal(parseRetrySeconds("wait 0s"), null, "zero seconds is not a wait");
  assert.equal(parseRetrySeconds("wait -5s"), null);
  assert.equal(parseRetrySeconds("please wait 999999s"), 600, "clamped to ten minutes");
});

await test("the countdown never goes negative", () => {
  const now = 10_000;
  assert.equal(secondsRemaining(now + 2_500, now), 3, "whole seconds, rounded up");
  assert.equal(secondsRemaining(now - 1, now), 0);
});

console.log("\ntrash retention");

await test("thirty days is the retention, and expiry is strictly past it", () => {
  assert.equal(TRASH_RETENTION_MS, 30 * 86_400_000);
  const now = 1_000_000_000_000;
  assert.equal(isTrashExpired({ deletedAt: now - TRASH_RETENTION_MS }, now), false, "on the boundary is still recoverable");
  assert.equal(isTrashExpired({ deletedAt: now - TRASH_RETENTION_MS - 1 }, now), true);
  assert.equal(isTrashExpired({ deletedAt: now }, now), false, "just deleted is the case the feature exists for");
});

console.log("\nusage statistics");

const week: UsageDayInput[] = [
  { day: "2026-09-20", uids: ["old-timer"], chat: 9 }, // outside the weekly window
  { day: "2026-09-30", uids: ["d"] },
  { day: "2026-10-04", uids: ["a", "b"], chat: 3, image: 1, auto: 2, code: 1 },
  { day: "2026-10-05", uids: ["b", "c"], chat: 2, auto: 1 },
  { day: "2026-10-06", uids: ["a", "c"], chat: 4, image: 2, self: 5, code: 2 },
];
const now = Date.UTC(2026, 9, 6, 12, 0, 0);

await test("WAU is a union of people, not a sum of days", () => {
  const summary = summarizeUsage(week, now);
  assert.equal(summary.wau, 4, "the same person twice in a week is one person");
});

await test("DAU is per-day, oldest first, one bar each", () => {
  const summary = summarizeUsage(week, now);
  assert.deepEqual(summary.dau, [
    { day: "2026-09-20", users: 1 },
    { day: "2026-09-30", users: 1 },
    { day: "2026-10-04", users: 2 },
    { day: "2026-10-05", users: 2 },
    { day: "2026-10-06", users: 2 },
  ]);
});

await test("the headline numbers come from the most recent day", () => {
  const summary = summarizeUsage(week, now);
  assert.equal(summary.latestDay, "2026-10-06");
  assert.equal(summary.latestUsers, 2);
});

await test("totals span all history and modes are ranked largest first", () => {
  const summary = summarizeUsage(week, now);
  assert.deepEqual(summary.totals, { chat: 18, image: 3 });
  assert.deepEqual(summary.modes, [
    { mode: "self", count: 5 },
    { mode: "auto", count: 3 },
    { mode: "code", count: 3 },
  ]);
});

await test("an empty history is zeros, not an error", () => {
  const summary = summarizeUsage([], now);
  assert.deepEqual(summary.dau, []);
  assert.equal(summary.wau, 0);
  assert.equal(summary.latestDay, null);
  assert.equal(summary.latestUsers, 0);
  assert.deepEqual(summary.totals, { chat: 0, image: 0 });
  assert.deepEqual(summary.modes, []);
});

await test("unsorted input is still read in day order", () => {
  const summary = summarizeUsage([...week].reverse(), now);
  assert.equal(summary.latestDay, "2026-10-06");
  assert.deepEqual(summary.dau.map((bar) => bar.day), week.map((row) => row.day));
});

console.log("\nthe wiring these features hang off");

await test("the composer still receives the server's countdown", () => {
  const page = read("app/chat/page.tsx");
  assert.match(page, /rateLimitUntil=\{rateLimitUntil\}/, "the countdown never reaches the composer");
  assert.match(page, /onStop=\{stopStreaming\}/, "a running answer cannot be stopped");
});

await test("a fallback updates the badge without announcing a failure", () => {
  const page = read("app/chat/page.tsx");
  // The old notice said the model "was changed automatically because the
  // current model is experiencing a problem". A fallback is routine; naming it
  // as a failure made every answer look degraded.
  assert.ok(!/model was changed automatically/i.test(page), "the fallback failure notice is back");
  assert.ok(!page.includes("experiencing a problem"), "the fallback failure sentence is back");
  assert.match(page, /if \(evt\.model\) \{/, "the badge no longer follows the model that answered");
  assert.match(
    page,
    /patchMessage\(assistantMsg\.id, \{ model: evt\.model \}\)/,
    "the answer must be labelled with the model that produced it"
  );
});

await test("the sitemap no longer lists the removed notes route", () => {
  const sitemap = read("app/sitemap.ts");
  assert.ok(!sitemap.includes("/notes"), "the sitemap still points a crawler at a 404");
});

await test("the repository says what the agent can do, not that it is read-only", () => {
  const page = read("app/chat/page.tsx");
  const thread = read("components/ChatThread.tsx");
  assert.ok(!page.includes(">read-only<"), "the misleading read-only label is back");
  assert.match(page, /reads · proposes/, "the repository chip still does not name the agent's capability");
  assert.match(page, /onPropose=\{handlePropose\}/, "the propose action never reaches the thread");
  assert.match(thread, /Propose this change/, "a read-only answer has no way to ask for a diff");
  assert.match(thread, /Starts a new Code request/, "the extra charge is not disclosed");
  assert.match(thread, /step\.detail/, "a refused proposal still hides its reasons");
});

await test("the page drops expired trash on start and listens for a wipe", () => {
  const page = read("app/chat/page.tsx");
  assert.match(page, /purgeTrash\(\)/, "expired trash is never dropped on start");
  assert.match(page, /openmi:data-wiped/, "the wipe event leaves the page on dead data");
});

await test("chat history is served from the account and never stored on the device", () => {
  const store = read("lib/db.ts");
  assert.ok(
    !/from "dexie"|new Dexie|indexedDB\.open/.test(store),
    "the session cache still opens a local database"
  );
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies.dexie, undefined, "dexie is still a dependency");
  assert.equal(pkg.dependencies["dexie-react-hooks"], undefined, "dexie-react-hooks is still a dependency");
  const cloud = read("lib/cloudHistory.ts");
  assert.match(cloud, /export async function loadChatsFromAccount/, "nothing pulls history when a session starts");
});

await test("the wipe button is the two-tap one and clears through lib/privacy", () => {
  const data = read("components/DataControls.tsx");
  assert.match(data, /deleteAllMyData/);
  assert.match(data, /Tap again to erase everything/, "the destructive button must need two taps");
});

await test("the sidebar opens overlays instead of a search section", () => {
  const sidebar = read("components/Sidebar.tsx");
  assert.match(sidebar, /SearchOverlay/);
  assert.match(sidebar, /TrashOverlay/);
  assert.ok(!sidebar.includes("GalleryOverlay"), "the removed gallery is still mounted");
});

await test("the console has the usage section with its chart", () => {
  const admin = read("components/AdminPanel.tsx");
  assert.match(admin, /<UsageSection \/>/, "the trend chart is not mounted in the console");
  assert.match(admin, /function UsageSection/);
});

await test("chat actions live behind a hold menu with the feature written out", () => {
  const sidebar = read("components/Sidebar.tsx");
  assert.match(sidebar, /startHold/, "holding a row does not open anything");
  assert.match(sidebar, /data-row-menu/, "the hold menu is not rendered");
  assert.match(sidebar, /label="Move to folder"/, "an action has no title");
  assert.match(sidebar, /label=\{chat\.pinned \? "Unpin chat" : "Pin chat"\}/, "pin has no title");
  assert.ok(
    !sidebar.includes("group-hover:block"),
    "the stacked hover buttons this replaced are back in the rail"
  );
});

await test("the About progress trail no longer claims retired features", () => {
  const about = read("app/about/page.tsx");
  assert.ok(!about.includes("Send later, read aloud"), "a removed feature is still listed as shipped");
  assert.ok(!about.includes("Image generation\", state: \"done\""), "image generation is still listed as shipped");
  assert.ok(!about.includes('{ label: "Next", state: "next" }'), "the placeholder row is back");
  assert.match(
    about,
    /PROGRESS\.filter\(\(item\) => item\.state === "done"\)\.length/,
    "the shipped count must count the shipped rows"
  );
});

console.log(
  failures === 0
    ? `\n${passes} passed\n`
    : `\n${passes} passed, ${failures} FAILED\n`
);
}

void main().then(() => {
  process.exit(failures === 0 ? 0 : 1);
});
