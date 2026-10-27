// ── Tests for the Dew currency ───────────────────────────────────────────────
//
// Dew is the only money the product has. Every rule about what a request costs,
// what a balance means, and whether a request may start is decided in
// lib/dew.ts and enforced by the routes — so the arithmetic here is the
// arithmetic the deployment runs on. A silent error in pricing, rounding, or
// the balance derivation is a real shortfall or an over-charge, not a failed
// test.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DAILY_FREE_DEW,
  DEW_PACKS,
  DEW_PER_HOUR_SESSION,
  DEW_PER_REQUEST,
  HOUR_SESSION_MS,
  PAID_DAILY_FREE_DEW,
  dailyAllowance,
  DEW_PER_UNIT,
  DEW_RESET_TIME_ZONE,
  DUST_THRESHOLD,
  LOW_BALANCE_THRESHOLD,
  canAfford,
  dailyDewRemaining,
  dewAvailableFrom,
  dewBalanceFrom,
  dewDay,
  estimateTokenUsage,
  formatDew,
  isSupportedTimeZone,
  nextSpent,
  requestPrice,
  roundDew,
  sessionPrice,
  sumCredits,
  toMillidew,
} from "../lib/dew";
import {
  PAID_BENEFITS,
  PAID_PLANS,
  currencyForLocale,
  formatPlanPrice,
  localPrice,
} from "../lib/pricing";
import { parseRedeemCode } from "../lib/redeemState";
import type { ModeId } from "../lib/models";

// ── Flat pricing ─────────────────────────────────────────────────────────────
// A request costs the same whatever the model writes. The price is keyed by
// model, so adding a model is a pricing decision rather than a formula.

assert.equal(requestPrice("auto"), DEW_PER_REQUEST.auto);
assert.equal(requestPrice("code"), DEW_PER_REQUEST.code);
// Every mode has a price and no price is free — a free mode would be a hole in
// the ledger, not a promotion.
for (const [mode, price] of Object.entries(DEW_PER_REQUEST)) {
  assert.ok(price > 0, `${mode} is priced at ${price}`);
  assert.ok(Number.isFinite(price), `${mode} is priced at a non-number`);
}
// The code model is the dearer one: it is the model tuned for repository work.
assert.ok(DEW_PER_REQUEST.code > DEW_PER_REQUEST.auto);
// DeepSeek V4.1 Flash: 2 Dew a message, or 3 for a whole hour in one chat.
assert.equal(DEW_PER_REQUEST.flash, 2);
assert.equal(sessionPrice("flash"), 3);
assert.equal(DEW_PER_HOUR_SESSION.flash, 3);
assert.equal(HOUR_SESSION_MS, 3_600_000);
// GPT-OSS 120B: 2 Dew a message, or 2 for a whole hour in one chat.
assert.equal(DEW_PER_REQUEST.code, 2);
assert.equal(sessionPrice("code"), 2);
assert.equal(DEW_PER_HOUR_SESSION.code, 2);
// A mode with no hourly price is billed per request and offered no session.
assert.equal(sessionPrice("auto"), null);
// An unknown mode falls back to the cheapest known price rather than zero.
assert.equal(requestPrice("nonsense" as ModeId), DEW_PER_REQUEST.auto);

// ── Rounding ─────────────────────────────────────────────────────────────────

assert.equal(roundDew(0.1 + 0.2), 0.3);
assert.equal(roundDew(1.005), 1.005);
assert.equal(roundDew(0), 0);
assert.equal(roundDew(-5), -5);

assert.equal(toMillidew(0.075), 75);
assert.equal(toMillidew(1.25), 1250);
assert.equal(toMillidew(0), 0);

// ── Balance derivation ────────────────────────────────────────────────────────

// Credits minus spent, floored at zero
assert.equal(dewBalanceFrom({ credits: { TRIAL: 25 }, spent: 12.375 }), 12.625);
assert.equal(dewBalanceFrom(null), 0);
assert.equal(dewBalanceFrom(undefined), 0);
assert.equal(dewBalanceFrom({}), 0);
assert.equal(dewBalanceFrom({ credits: { TRIAL: 25 }, spent: 30 }), 0);
assert.equal(dewBalanceFrom({ spent: 5 }), 0);
assert.equal(dewBalanceFrom({ credits: { TRIAL: 25 }, spent: -3 }), 25);

// ── Sum credits ───────────────────────────────────────────────────────────────
//
// sumCredits is the accumulator dewBalanceFrom subtracts spent *in*, so it
// answers in millidew — 1000 to the Dew — and the division back into Dew
// happens there.

assert.equal(sumCredits(null), 0);
assert.equal(sumCredits({}), 0);
assert.equal(sumCredits({ TRIAL: 25, CODE1: 100 }), 125_000);
assert.equal(sumCredits({ TRIAL: 25, bad: "not a number", CODE1: 100 }), 125_000);
assert.equal(sumCredits({ TRIAL: 25, negative: -10, CODE1: 100 }), 125_000);
assert.equal(dewBalanceFrom({ credits: { TRIAL: 25, CODE1: 100 }, spent: 0 }), 125);

// ── The daily free allotment ─────────────────────────────────────────────────
//
// Ten free Dew per day, fifteen with a paid pass, spent before paid credit and
// reset at midnight in the account's own zone — Kuala Lumpur until the browser
// registers one. The bucket is not carried over: a day with 4 Dew left hands
// out 10 the next day, never 14.

assert.equal(DAILY_FREE_DEW, 10);
assert.equal(PAID_DAILY_FREE_DEW, 15);
assert.equal(dailyAllowance(true), PAID_DAILY_FREE_DEW);
assert.equal(dailyAllowance(false), DAILY_FREE_DEW);
assert.equal(DEW_RESET_TIME_ZONE, "Asia/Kuala_Lumpur");
// A used bucket is judged against the same allowance it was filled with.
assert.equal(dailyDewRemaining({ dailyDay: "2026-10-24", dailySpent: 4 }, "2026-10-24", 15), 11);
assert.equal(dailyDewRemaining({ dailyDay: "2026-10-24", dailySpent: 4 }, "2026-10-25", 15), 15);

// Midnight is the account's, not the host's, and the date line really moves.
const instant = Date.parse("2026-10-23T16:00:00Z");
assert.equal(dewDay(instant, "Asia/Kuala_Lumpur"), "2026-10-24");
assert.equal(dewDay(instant, "America/Los_Angeles"), "2026-10-23");
assert.equal(dewDay(instant, "Pacific/Kiritimati"), "2026-10-24");
assert.equal(
  dewDay(instant, "Not/AZone"),
  "2026-10-24",
  "an unusable stored zone must fall back rather than remove a balance"
);
assert.equal(dewDay(Date.parse("2026-10-24T06:59:59Z"), "America/Los_Angeles"), "2026-10-23");
assert.equal(dewDay(Date.parse("2026-10-24T07:00:00Z"), "America/Los_Angeles"), "2026-10-24");
assert.equal(isSupportedTimeZone("Asia/Kuala_Lumpur"), true);
assert.equal(isSupportedTimeZone("Not/AZone"), false);
assert.equal(isSupportedTimeZone(""), false);
assert.equal(isSupportedTimeZone(null), false);

const today = "2026-10-24";
assert.equal(dailyDewRemaining(null, today), 10, "a wallet that has never spent has the full bucket");
assert.equal(dailyDewRemaining({ dailyDay: today, dailySpent: 0 }, today), 10);
assert.equal(dailyDewRemaining({ dailyDay: today, dailySpent: 2.5 }, today), 7.5);
assert.equal(dailyDewRemaining({ dailyDay: today, dailySpent: 10 }, today), 0);
assert.equal(dailyDewRemaining({ dailyDay: today, dailySpent: 15 }, today), 0, "a bucket cannot owe Dew");
assert.equal(dailyDewRemaining({ dailyDay: today, dailySpent: Number.NaN }, today), 10);
assert.equal(
  dailyDewRemaining({ dailyDay: "2026-10-23", dailySpent: 4 }, today),
  10,
  "yesterday's leftover must not carry over"
);
assert.equal(
  dailyDewRemaining({ dailyDay: "2026-10-25", dailySpent: 5 }, today),
  5,
  "a day that has not arrived — or a clock moved backwards — must not refill"
);
assert.equal(dailyDewRemaining({ dailyDay: "2026-10-25", dailySpent: 2 }, today), 8);

// Free Dew rides on top of what was bought and is spent first.
assert.equal(dewAvailableFrom({ credits: { TRIAL: 25 }, spent: 0 }, today), 35);
assert.equal(dewAvailableFrom({ credits: { TRIAL: 25 }, spent: 24 }, today), 11);
assert.equal(dewAvailableFrom({ credits: { TRIAL: 25 }, spent: 30 }, today), 10, "paid Dew floors at zero, the bucket does not");
assert.equal(dewAvailableFrom({ credits: {}, spent: 0, dailyDay: today, dailySpent: 5 }, today), 5);
// Paid Dew does not expire with the bucket.
assert.equal(dewAvailableFrom({ credits: { CODE1: 100 }, spent: 0, dailyDay: "2026-10-20", dailySpent: 5 }, today), 110);

// ── nextSpent ─────────────────────────────────────────────────────────────────

assert.equal(nextSpent(0, 0.25), 0.25);
assert.equal(nextSpent(12.375, 0.25), 12.625);
assert.equal(nextSpent(0, 0), 0);
assert.equal(nextSpent(5, -1), 5);
assert.equal(nextSpent(-3, 1), 1);

// ── canAfford ─────────────────────────────────────────────────────────────────
// The route passes the model's own price, so the threshold is exactly one
// request's worth rather than "some dust".

assert.equal(canAfford(DUST_THRESHOLD), true);
assert.equal(canAfford(0.04), false);
assert.equal(canAfford(25), true);
assert.equal(canAfford(0), false);
assert.equal(canAfford(requestPrice("auto"), requestPrice("auto")), true, "exactly enough is enough");
assert.equal(canAfford(requestPrice("auto") - 0.001, requestPrice("auto")), false);
assert.equal(canAfford(requestPrice("code"), requestPrice("code")), true);
// Someone holding only the auto price cannot start a code request.
assert.equal(canAfford(requestPrice("auto"), requestPrice("code")), false);
// Someone holding only the per-request price cannot start a code hour.
assert.equal(canAfford(requestPrice("code"), sessionPrice("code") ?? 0), true, "exactly enough is enough for the hour too");

// ── Thresholds ────────────────────────────────────────────────────────────────

assert.equal(DUST_THRESHOLD, 0.05);
assert.equal(LOW_BALANCE_THRESHOLD, 10);
assert.equal(DEW_PER_UNIT, 100);

// ── Dew packs ─────────────────────────────────────────────────────────────────

assert.equal(DEW_PACKS.length, 4);
for (let i = 1; i < DEW_PACKS.length; i++) {
  assert.ok(DEW_PACKS[i].dew > DEW_PACKS[i - 1].dew, "packs must be ordered by dew");
}
for (const pack of DEW_PACKS) {
  assert.ok(pack.dew > 0, "pack dew must be positive");
  assert.ok(pack.ringgit > 0, "pack ringgit must be positive");
}

// ── Token counting survives the flat price ───────────────────────────────────
// Tokens no longer decide the bill, but they are still counted and reported.
// A provider that never reports usage is estimated rather than left blank.

const estimated = estimateTokenUsage("abcd");
assert.equal(estimated.completion, 1);
assert.equal(estimated.prompt, 0);
assert.equal(estimateTokenUsage("").completion, 0);
assert.equal(estimateTokenUsage("a".repeat(400)).completion, 100);

// ── formatDew ─────────────────────────────────────────────────────────────────

assert.equal(formatDew(0), "0");
assert.equal(formatDew(0.075), "0.075");
assert.equal(formatDew(12.5), "12.5");
assert.equal(formatDew(25), "25");
assert.equal(formatDew(0.1 + 0.2), "0.3");

// ── Dew codes parse correctly ─────────────────────────────────────────────────

const dewCode = parseRedeemCode({ code: "dew500", dew: 500, active: true, createdAt: Date.now() });
assert.ok(dewCode);
assert.equal(dewCode.dew, 500);
assert.equal(dewCode.active, true);
// A Dew code ignores any plan value — a plan cannot ride in on a Dew code
const dewCodeWithPlan = parseRedeemCode({ code: "dew500", dew: 500, plan: "lunar", days: 365, active: true, createdAt: Date.now() });
assert.ok(dewCodeWithPlan);
assert.equal("plan" in dewCodeWithPlan, false, "the stored plan is not honoured, and not kept");
assert.equal("days" in dewCodeWithPlan, false, "nor is a length");
assert.equal(parseRedeemCode({ code: "bad", dew: -5, createdAt: Date.now() }), null);
assert.equal(parseRedeemCode({ code: "bad", dew: 200000, createdAt: Date.now() }), null);

// ── The route actually charges ────────────────────────────────────────────────
//
// Pricing that nobody enforces is a price list. These read the source of the
// route and of the deduction itself, because a regression there stays invisible
// until a balance quietly stops moving.

/** A file with its comments stripped, so an explanation cannot pass for code. */
function source(relative: string): string {
  return readFileSync(join(process.cwd(), relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const chatSource = source(join("app", "api", "chat", "route.ts"));
const dewSource = source(join("lib", "serverDew.ts"));
const deductDewSource = dewSource.slice(dewSource.indexOf("export async function deductDew"), dewSource.indexOf("export interface DewChargeLine"));

// The chat route reads the balance server-side, refuses before the model runs,
// and charges once the answer is fully known.
assert.ok(chatSource.includes("resolveDew("), "the chat route must resolve the balance server-side");
assert.ok(chatSource.includes("canAfford("), "and pre-flight it before any model call");
assert.ok(chatSource.includes("deductDew("), "and deduct when the answer is done");
assert.ok(
  chatSource.includes("await deductDew("),
  "the deduction must be awaited: once the stream closes a serverless deployment may freeze the process, and a charge still in flight never happens"
);
// The price is flat and comes from the model, not from the tokens.
assert.ok(chatSource.includes("requestPrice(requested)"), "the route must price the request by its model");
assert.ok(
  !chatSource.includes("calcDewCost("),
  "a per-token calculation is back in the chat route; pricing is flat now"
);
// Tokens are still reported.
assert.ok(chatSource.includes("prompt: totalUsage.prompt"), "the token count is no longer reported");

// A balance is never whatever the caller says it is.
assert.ok(!/body\.(dewBalance|balance)\b/.test(chatSource), "chat must never read a balance from the request body");
assert.ok(
  !/query\.(dewBalance|balance)\b/.test(chatSource) && !/searchParams\.get\(\s*["'`]balance/.test(chatSource),
  "chat must never read a balance from the query string"
);
assert.ok(!/body\.plan\b/.test(chatSource), "chat must never read a plan from the request body");
assert.ok(!chatSource.includes("consumeUsage("), "chat does not count messages: Dew is the only control");

// The deduction is one atomic statement in the database, and the caller cannot
// reach the column it moves. The Realtime Database needed an ETag dance because
// REST had no transactions; Postgres does not, so the charge is an increment
// rather than a read-modify-write that could lose a race.
const dewSchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261023000500_dew_redeem.sql"),
  "utf8"
);
assert.ok(dewSource.includes("dewBalanceFrom("), "the Dew reader must derive the balance from credits and spend");
assert.ok(
  deductDewSource.includes('rpc("deduct_dew"'),
  "the deduction must go through the database function, not a client-side total"
);
assert.ok(
  deductDewSource.includes('rpc("deduct_dew_split"'),
  "the charge must report how much free and paid Dew paid for it, not only the total"
);
assert.ok(
  /set spent = public\.dew_wallets\.spent \+ excluded\.spent/.test(dewSchema),
  "the spend must be incremented in SQL, or two simultaneous charges can overwrite each other"
);
assert.ok(
  /create or replace function public\.deduct_dew\(p_amount numeric\)[\s\S]*security definer/.test(dewSchema),
  "deduct_dew must run with the rights to write the wallet it owns"
);
assert.ok(
  /revoke all on function public\.deduct_dew\(numeric\) from public/.test(dewSchema),
  "deduct_dew must not be callable without a session"
);
assert.ok(
  /grant select on public\.dew_wallets to authenticated/.test(dewSchema) &&
    !/grant (update|insert)[^;]*on public\.dew_wallets to authenticated/.test(dewSchema),
  "a caller must be able to read their spend and not write it, or a modified client could reset its own balance"
);
assert.ok(deductDewSource.includes("reason:"), "a refusal is reported with its own diagnosis, not just a boolean");

// ── The daily bucket in the database ────────────────────────────────────────
//
// The reset is a comparison against the stored day, not arithmetic on a
// running credit, and the free bucket is spent before the paid wallet. Both
// happen inside the same function so a charge cannot spend one and forget the
// other.

const dailySchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261024000200_daily_dew.sql"),
  "utf8"
);
const timezoneSchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261024000300_dew_timezone.sql"),
  "utf8"
);
assert.ok(dewSource.includes("dailyDewRemaining("), "the server must report today's free Dew");
assert.ok(dewSource.includes("dewDay(Date.now(), timeZone)"), "the server must read the account's day");
assert.ok(
  dewSource.includes("isSupportedTimeZone("),
  "a stored zone is untrusted input and must be validated before it is used"
);
assert.ok(dailySchema.includes("daily_day"), "the wallet must remember which day its bucket belongs to");
assert.ok(dailySchema.includes("daily_spent"), "the wallet must remember how much free Dew was used");
// The bucket size moved to 10 free / 15 paid in the pricing migration, where it
// is read from the live pass instead of being a constant. The two numbers here
// are the ones in lib/dew.ts, and neither may drift from them.
const pricingSchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261028000000_pricing_sessions.sql"),
  "utf8"
);
assert.ok(
  /free_per_day numeric := case when public\.has_paid_pass\(\) then 15 else 10 end/.test(
    pricingSchema
  ),
  "the daily amount must be 10 free / 15 paid, matching DAILY_FREE_DEW and PAID_DAILY_FREE_DEW"
);
assert.ok(
  /create or replace function public\.deduct_dew_split\(p_amount numeric\)[\s\S]*security definer/.test(
    pricingSchema
  ),
  "the pass-sized bucket must live in the one locked charge function"
);
assert.ok(
  /free_charge := least\(charged, free_left\)/.test(timezoneSchema),
  "free Dew must be spent before paid credit"
);
assert.ok(
  /for update/.test(timezoneSchema),
  "the wallet must be locked while the bucket and the spend are split, or two charges can both take the free Dew"
);
assert.ok(
  /revoke all on function public\.deduct_dew\(numeric\) from public/.test(timezoneSchema) &&
    /grant execute on function public\.deduct_dew\(numeric\) to authenticated/.test(timezoneSchema),
  "the rewritten deduction must keep the same execute grants"
);
assert.ok(
  !/grant (update|insert)[^;]*on public\.dew_wallets to authenticated/.test(timezoneSchema),
  "the daily columns must only move through deduct_dew()"
);

// ── The account's own timezone in the database ──────────────────────────────
//
// The final `deduct_dew()` reads the account's stored zone instead of a fixed
// one, refills only when a later day has actually arrived, and the RPC that
// writes the zone refuses to overwrite one that is already set.

assert.ok(timezoneSchema.includes("add column if not exists timezone"));
assert.ok(timezoneSchema.includes("set_profile_timezone"), "the browser needs a door to report its zone");
assert.ok(
  /pg_timezone_names/.test(timezoneSchema),
  "the zone must be validated against PostgreSQL's own list"
);
assert.ok(
  /at time zone account_timezone/.test(timezoneSchema),
  "the database must decide the day in the account's zone, not the caller's"
);
assert.ok(
  /where public\.profiles\.timezone is null/.test(timezoneSchema),
  "the registered zone must be write-once, or an account could ask for a new day at will"
);
assert.ok(
  /daily_spent = case[\s\S]*?daily_day is null or daily_day < today then free_charge[\s\S]*?daily_spent \+ free_charge/.test(
    timezoneSchema
  ),
  "a new day must discard the leftover bucket instead of adding to it"
);
assert.ok(
  /daily_day = case[\s\S]*?then today[\s\S]*?else daily_day/.test(timezoneSchema),
  "the bucket's day must never move backwards"
);
assert.ok(
  !/daily_day is distinct from today/.test(timezoneSchema),
  "the final reset must only refill on a later day"
);
assert.ok(
  /grant execute on function public\.set_profile_timezone\(text\) to authenticated/.test(timezoneSchema),
  "a signed-in account must be able to report its zone"
);

// ── The free/paid split on the ledger ──────────────────────────────────────
//
// The activity page is only honest if the charge and the history agree on the
// split. The database function computes both inside one locked statement; the
// chat route records the same two halves it was told.

const activitySchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261024000500_dew_activity.sql"),
  "utf8"
);
assert.ok(activitySchema.includes("add column if not exists free_dew"));
assert.ok(activitySchema.includes("add column if not exists paid_dew"));
assert.ok(
  /create or replace function public\.deduct_dew_split\(p_amount numeric\)/.test(activitySchema),
  "the split must be produced by the same function that moves the wallet"
);
assert.ok(
  /free_amount := least\(charged, free_left\)/.test(activitySchema) &&
    /paid_amount := charged - free_amount/.test(activitySchema),
  "the halves must be free first and the remainder paid"
);
assert.ok(
  /grant execute on function public\.deduct_dew_split\(numeric\) to authenticated/.test(activitySchema),
  "the server must be able to call the split as the caller"
);
assert.ok(
  activitySchema.includes("deduct_dew_split(numeric)"),
  "the schema audit must know about the new function"
);
assert.ok(
  chatSource.includes("free: deduct.freeCharged"),
  "the chat route must write the free half it was actually charged"
);

// ── Hour sessions ───────────────────────────────────────────────────────────
// The hour is a server-owned row. One account holds at most one at a time, the
// charge and the row are written together, and a live session only makes a
// message free when it names the same chat.

assert.ok(
  /create table if not exists public\.hour_sessions[\s\S]*owner uuid primary key/.test(pricingSchema),
  "one row per owner is what makes a second active session impossible"
);
assert.ok(
  /create or replace function public\.start_hour_session\(p_chat_id text\)[\s\S]*security definer/.test(
    pricingSchema
  ),
  "starting an hour must run server-side, not in the browser"
);
assert.ok(
  /charged numeric := 2/.test(pricingSchema),
  "the hour price must be a server constant, not an RPC argument a caller chooses"
);
assert.ok(
  !/p_price/.test(pricingSchema),
  "no caller-supplied price may reach the session charge"
);
assert.ok(
  /create table if not exists public\.paid_passes[\s\S]*for select to authenticated/.test(pricingSchema) &&
    /revoke all on public\.paid_passes from anon, authenticated/.test(pricingSchema) &&
    /grant select on public\.paid_passes to authenticated/.test(pricingSchema),
  "a pass must be readable by its owner and writable only by the admin function"
);
assert.ok(
  !/add column if not exists plan_expires_at/.test(pricingSchema),
  "a paid flag on the owner-writable profiles row would be a self-service upgrade"
);
assert.ok(
  /pg_advisory_xact_lock\(hashtextextended\('openmi-hour:'/.test(pricingSchema),
  "two simultaneous starts must serialise, or both could pass the active check"
);
assert.ok(
  /perform public\.deduct_dew_split\(charged\)/.test(pricingSchema),
  "the hour must be charged in the same transaction that creates it"
);
assert.ok(
  /reason', 'active'/.test(pricingSchema) && /reason', 'insufficient'/.test(pricingSchema),
  "a second hour and an unaffordable hour are refusals the interface can explain"
);
assert.ok(
  /create or replace function public\.end_hour_session\(\)[\s\S]*owner = auth\.uid\(\)/.test(pricingSchema),
  "ending an hour must only touch the caller's own row"
);
assert.ok(
  /create or replace function public\.admin_grant_plan\(p_uid uuid, p_days integer\)[\s\S]*public\.is_admin\(\)/.test(
    pricingSchema
  ),
  "a paid pass must be granted by the database's own admin check"
);
assert.ok(
  /revoke all on public\.hour_sessions from anon, authenticated/.test(pricingSchema) &&
    /grant select on public\.hour_sessions to authenticated/.test(pricingSchema),
  "a session is readable by its owner and writable only through the functions"
);
assert.ok(
  /revoke all on function public\.start_hour_session\(text\) from public/.test(pricingSchema),
  "starting an hour must not be callable by an anonymous session"
);
assert.ok(
  chatSource.includes("readHourSessionForChat"),
  "the chat route must match the session to the chat before it skips the charge"
);
assert.ok(
  /!coveredBySession && identity/.test(chatSource),
  "a covered message must not be charged a second time"
);

// ── Paid plans and local prices ─────────────────────────────────────────────
// $4 for 15 days and $8 for 30 days, shown in the reader's currency. The pass
// raises the same daily bucket rather than inventing a second balance.

assert.deepEqual(
  PAID_PLANS.map((plan) => [plan.days, plan.usd]),
  [
    [15, 4],
    [30, 8],
  ]
);
assert.ok(PAID_PLANS.every((plan) => plan.ringgit > 0 && plan.label.length > 0));
assert.ok(PAID_BENEFITS.includes("Bumped up to 15 Dew"));
assert.ok(PAID_BENEFITS.includes("Priority support"));
assert.ok(PAID_BENEFITS.includes("More usage"));
assert.ok(PAID_BENEFITS.includes("Everything in Free"));
assert.equal(currencyForLocale("en-MY"), "MYR");
assert.equal(currencyForLocale("de-DE"), "EUR");
assert.equal(currencyForLocale("en-GB"), "GBP");
assert.equal(currencyForLocale("en-ZZ"), "USD");
assert.equal(formatPlanPrice(8, "en-US"), "$8");
const malaysian = localPrice(8, "en-MY");
assert.equal(malaysian.currency, "MYR");
assert.equal(malaysian.approximate, true);
assert.ok(malaysian.amount >= 30 && malaysian.amount <= 40, "eight dollars is about RM 35");
assert.ok(malaysian.formatted.includes("RM"));
