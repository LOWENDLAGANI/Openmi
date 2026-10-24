// ── Tests for the Dew activity report ────────────────────────────────────────
//
// The activity page is the only place a person can see why their balance moved.
// The arithmetic here decides what that page says, so it is tested against a
// fixed instant and a fixed zone rather than against the machine's clock.
//
//   bun run test

import assert from "node:assert/strict";
import { summarizeDewActivity } from "../lib/dewActivity";

const NOW = Date.parse("2026-11-05T12:00:00Z"); // 20:00 in Kuala Lumpur
const TZ = "Asia/Kuala_Lumpur";
const HOUR = 3_600_000;
const DAY = 86_400_000;

const report = summarizeDewActivity(
  [
    { at: NOW, dew: 0.5, model: "auto", free: 0.25 },
    { at: NOW - HOUR, dew: 0.5, model: "code", free: 0 },
    { at: NOW - 10 * DAY, dew: 2, model: "auto", free: 1.5 },
    { at: NOW - 40 * DAY, dew: 9, model: "auto", free: 9 },
    { at: 0, dew: 4, model: "auto", free: 0 },
  ],
  [
    { at: NOW, code: "TRIAL", amount: 25 },
    { at: NOW - 2 * DAY, code: "TOPUP-ABC", amount: 100 },
    { at: NOW - 40 * DAY, code: "OLD", amount: 50 },
  ],
  { now: NOW, timeZone: TZ, windowDays: 30 }
);

assert.equal(report.windowDays, 30);
assert.equal(report.days.length, 30, "the window is a complete set of days");

// Totals: the 40-day-old charge and the invalid timestamp are outside the window.
assert.equal(report.totals.spend, 3);
assert.equal(report.totals.free, 1.75);
assert.equal(report.totals.paid, 1.25);
assert.equal(report.totals.requests, 3);
assert.equal(report.totals.free + report.totals.paid, report.totals.spend, "the split must sum to the spend");

// Month: today and yesterday are November; the 10-day-old charge is October.
assert.equal(report.totals.month, "2026-11");
assert.equal(report.totals.thisMonth, 1);

const today = report.days[report.days.length - 1];
assert.ok(today);
assert.equal(today.day, "2026-11-05");
assert.equal(today.spend, 1);
assert.equal(today.free, 0.25);
assert.equal(today.requests, 2);

// Models are ordered by spend, and the raw ledger ids are kept for the UI to label.
assert.deepEqual(report.models, [
  { model: "auto", requests: 2, spend: 2.5 },
  { model: "code", requests: 1, spend: 0.5 },
]);

// Credits are newest first, filtered to the window, and totalled.
assert.deepEqual(
  report.credits.map((credit) => credit.code),
  ["TRIAL", "TOPUP-ABC"]
);
assert.equal(report.creditTotal, 125);

// A legacy charge with no recorded split is paid credit, not invented free Dew.
const legacy = summarizeDewActivity(
  [{ at: NOW, dew: 0.5, model: "auto", free: 0 }],
  [],
  { now: NOW, timeZone: TZ }
);
assert.equal(legacy.totals.free, 0);
assert.equal(legacy.totals.paid, 0.5);

// A corrupted split larger than the price is clamped to the price, never a refund.
const corrupt = summarizeDewActivity(
  [{ at: NOW, dew: 0.25, model: "auto", free: 99 }],
  [],
  { now: NOW, timeZone: TZ }
);
assert.equal(corrupt.totals.free, 0.25);
assert.equal(corrupt.totals.paid, 0);

// Quiet days are present, in order, and cost nothing.
assert.equal(report.days[0].spend, 0);
assert.ok(report.days[0].day < report.days[report.days.length - 1].day);

// The same instant can be a different day in another account's zone.
const la = summarizeDewActivity([], [], {
  now: Date.parse("2026-11-05T03:00:00Z"),
  timeZone: "America/Los_Angeles",
});
assert.equal(la.days[la.days.length - 1]?.day, "2026-11-04");

// The window is clamped so a caller cannot ask for a whole history in one page.
const clamped = summarizeDewActivity([], [], { now: NOW, timeZone: TZ, windowDays: 500 });
assert.equal(clamped.windowDays, 90);
assert.ok(clamped.days.length <= 90);

console.log("dew-activity: all checks passed");
