// ── An hour that bought nothing is given back ────────────────────────────────
//
// The rails a build cannot check by compiling, because they are about money:
//
//   * a refund is decided by the database, never by the browser;
//   * it happens once, and only while the hour has no reply;
//   * free Dew goes back to the day it was spent on, not into a wallet;
//   * an abandoned hour is given back on the next read, and a failed request is
//     given back by the route that failed and again by the client, harmlessly.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

const schema = read("supabase/migrations/20261029000300_hour_refunds.sql");

test("the refund is decided in the database, once, and only without a reply", () => {
  assert.match(
    schema,
    /create or replace function public\.refund_hour_session\(p_reason text default 'failed'\)[\s\S]*?security definer/,
    "the refund function is missing or does not run with the rights to write a wallet"
  );
  assert.match(schema, /if row\.refunded_at is not null then/, "a refund can be paid twice");
  assert.match(schema, /if row\.reply_at is not null then/, "a used hour can be refunded");
  assert.match(schema, /'reason', 'used'/, "a used hour is not named as used");
  assert.match(schema, /row\.started_at < now\(\) - interval '24 hours'/, "an old hour can be replayed");
  assert.match(schema, /revoke all on function public\.refund_hour_session\(text\) from public/, "the refund is public");

  const route = read("app/api/session/route.ts");
  assert.match(route, /body\.action === "refund"/, "the session route cannot refund");
  assert.match(route, /refundHourSession\(/, "the route does not call the refund function");
  assert.ok(!route.includes("row.reply_at"), "the route is deciding what the database must decide");
});

test("the split is refunded where it came from, and free Dew stays a day bucket", () => {
  assert.match(schema, /add column if not exists free_charged numeric/, "the free half of the charge is not recorded");
  assert.match(schema, /add column if not exists paid_charged numeric/, "the paid half is not recorded");
  assert.match(schema, /add column if not exists charge_day date/, "the day the charge belongs to is not recorded");
  assert.match(schema, /set spent = greatest\(0, spent - row\.paid_charged\)/, "paid Dew is not restored");
  assert.match(
    schema,
    /if row\.charge_day is not null and row\.charge_day = today then/,
    "free Dew is refunded outside its own day"
  );
  assert.match(schema, /set daily_spent = greatest\(0, w\.daily_spent - row\.free_charged\)/, "free Dew is not restored");
});

test("an hour nobody sent a prompt on is refunded automatically", () => {
  assert.match(
    schema,
    /create or replace function public\.auto_refund_idle_hour\(\)[\s\S]*?security definer/,
    "the abandoned-hour rail is missing"
  );
  assert.match(schema, /if row\.prompt_at is not null or row\.reply_at is not null then/, "a prompted hour can be written off by a clock");
  assert.match(schema, /started_at > now\(\) - interval '10 minutes'/, "the grace period is not ten minutes");
  assert.match(schema, /refund_hour_session\('no-prompt'\)/, "the idle rail does not refund");

  const route = read("app/api/session/route.ts");
  assert.match(route, /autoRefundIdleHour\(authorization\)/, "reading a session never refunds an abandoned one");

  assert.match(
    schema,
    /perform public\.refund_hour_session\('unused-before-restart'\)/,
    "starting a new hour does not close an unused predecessor"
  );
});

test("a failed chat or agent request asks for the hour back", () => {
  const chat = read("app/api/chat/route.ts");
  assert.match(chat, /markHourSessionActivity\(authorization, "prompt"\)/, "the first prompt is not recorded");
  assert.match(chat, /markHourSessionActivity\(authorization, "reply"\)/, "an answer does not mark the hour used");
  assert.match(chat, /refundHourSession\(authorization, "no-model"\)/, "a deployment with no model does not refund");
  assert.match(chat, /refundHourSession\(authorization, "provider-failed"\)/, "all providers failing does not refund");
  assert.match(chat, /refundHourSession\(authorization, "empty-answer"\)/, "an empty answer does not refund");

  const step = read("app/api/agent/step/route.ts");
  assert.match(step, /refundHourSession\(authorization, "agent-failed"\)/, "a failed agent step does not refund");
  assert.match(step, /refundHourSession\(authorization, "empty-step"\)/, "an empty agent step does not refund");
  assert.match(step, /markHourSessionActivity\(authorization, "reply"\)/, "an agent answer does not mark the hour used");

  const page = read("app/chat/page.tsx");
  assert.match(page, /requestHourRefund\("send-failed"\)/, "a failed send in the browser does not ask for a refund");
  assert.match(page, /requestHourRefund\("empty-answer"\)/, "an empty browser answer does not ask for a refund");
  assert.match(page, /action: "refund"/, "the browser helper does not call the refund action");
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
