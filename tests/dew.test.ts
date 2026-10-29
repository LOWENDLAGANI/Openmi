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
  DEW_PER_HOUR,
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
  roundDew,
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

// ── One price: an hour ───────────────────────────────────────────────────────
// There is no per-request charge. Three Dew buys an hour of usage on the model it
// was bought for, in every chat, and the hour is charged once when it starts.

assert.equal(DEW_PER_HOUR, 3);
assert.equal(HOUR_SESSION_MS, 3_600_000);

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
assert.equal(dewBalanceFrom({ credits: { TRIAL: 5 }, spent: 12.375 }), 0);
assert.equal(dewBalanceFrom(null), 0);
assert.equal(dewBalanceFrom(undefined), 0);
assert.equal(dewBalanceFrom({}), 0);
assert.equal(dewBalanceFrom({ credits: { TRIAL: 5 }, spent: 30 }), 0);
assert.equal(dewBalanceFrom({ spent: 5 }), 0);
assert.equal(dewBalanceFrom({ credits: { TRIAL: 5 }, spent: -3 }), 5);

// ── Sum credits ───────────────────────────────────────────────────────────────
//
// sumCredits is the accumulator dewBalanceFrom subtracts spent *in*, so it
// answers in millidew — 1000 to the Dew — and the division back into Dew
// happens there.

assert.equal(sumCredits(null), 0);
assert.equal(sumCredits({}), 0);
assert.equal(sumCredits({ TRIAL: 5, CODE1: 100 }), 105_000);
assert.equal(sumCredits({ TRIAL: 5, bad: "not a number", CODE1: 100 }), 105_000);
assert.equal(sumCredits({ TRIAL: 5, negative: -10, CODE1: 100 }), 105_000);
assert.equal(dewBalanceFrom({ credits: { TRIAL: 5, CODE1: 100 }, spent: 0 }), 105);

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
assert.equal(dewAvailableFrom({ credits: { TRIAL: 5 }, spent: 0 }, today), 15);
assert.equal(dewAvailableFrom({ credits: { TRIAL: 5 }, spent: 24 }, today), 10);
assert.equal(dewAvailableFrom({ credits: { TRIAL: 5 }, spent: 30 }, today), 10, "paid Dew floors at zero, the bucket does not");
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
assert.equal(canAfford(DEW_PER_HOUR, DEW_PER_HOUR), true, "exactly enough for an hour is enough");
assert.equal(canAfford(DEW_PER_HOUR - 0.001, DEW_PER_HOUR), false);
assert.equal(canAfford(DEW_PER_HOUR + 10, DEW_PER_HOUR), true);

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

// The chat route requires the account's hour server-side, and refuses before the
// model runs. A request itself costs nothing.
assert.ok(
  chatSource.includes("readHourSession("),
  "the chat route must require the caller's hour before answering"
);
assert.ok(
  chatSource.includes("outOfDewMessage()"),
  "a caller with no live hour is refused with the hour's price"
);
assert.ok(
  !chatSource.includes("deductDew("),
  "no per-request charge: the hour was paid for when it started"
);
assert.ok(!chatSource.includes("requestPrice("), "a message has no price of its own any more");
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
  !dewSource.includes("deductDew"),
  "usage is billed by the hour, so no per-request charge may survive in the server"
);
assert.ok(
  !dewSource.includes('rpc("deduct_dew_split"'),
  "the only charge is starting an hour; nothing charges a message"
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

// ── One charge function, with nothing for a column name to collide with ────
//
// The charge had been re-declared four times (`deduct_dew`, `deduct_dew_split`,
// a patched copy of `deduct_dew_split`, and a jsonb `dew_charge`), and the
// copies are what broke it. This migration leaves exactly one function — a price
// in, the new paid spend out — and drops the rest.

const chargeSchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261028000200_charge_dew.sql"),
  "utf8"
);
const chargeCode = chargeSchema.replace(/--.*$/gm, "");
assert.ok(
  /create function public\.start_hour_session\(\)\s*\nreturns jsonb/.test(chargeCode),
  "the one charge must answer jsonb: a RETURNS TABLE column is the variable that made the old charge ambiguous"
);
assert.ok(
  !/returns table/.test(chargeCode),
  "no charge function may declare an OUT parameter again"
);
assert.ok(
  /drop function if exists public\.deduct_dew_split\(numeric\)/.test(chargeCode),
  "the table-returning body must be dropped, not patched: create or replace cannot change a return type"
);
assert.ok(
  /drop function if exists public\.deduct_dew\(numeric\)/.test(chargeCode) &&
    /drop function if exists public\.dew_charge\(numeric\)/.test(chargeCode),
  "the duplicate doors must be deleted rather than left as a second way to charge"
);
assert.ok(
  /set spent = w\.spent \+ paid_charged/.test(chargeCode),
  "the wallet increment must name the row alias it reads"
);
assert.ok(
  !/returning\s+spent/.test(chargeCode),
  "no RETURNING spent: that is the ambiguity itself"
);
assert.ok(
  /for update/.test(chargeCode),
  "the wallet must still be locked while the bucket and the spend are split"
);
assert.ok(
  /delete from public\.schema_expected/.test(chargeCode),
  "the audit must stop looking for the functions this file removes, or the banner reports a gap nobody can close"
);
assert.ok(
  /notify pgrst/.test(chargeCode),
  "PostgREST caches signatures: the return type changed, so it must be told to look again"
);
assert.ok(
  /grant usage on schema public to anon, authenticated/.test(chargeSchema),
  "EXECUTE without schema USAGE is still permission denied, so the charge must grant it"
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

// ── Hour sessions ───────────────────────────────────────────────────────────
// The hour is a server-owned row and the only thing that costs Dew. One account
// holds at most one at a time, the charge and the row are written together, and
// a live hour covers every chat on the one model it was bought for.

const hourSchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261028000200_charge_dew.sql"),
  "utf8"
);
assert.ok(
  /create function public\.start_hour_session\(\)\s*\nreturns jsonb/.test(hourSchema),
  "the one charge takes no argument and declares no OUT parameter to be ambiguous with"
);
assert.ok(
  /price numeric := 3/.test(hourSchema),
  "three Dew is the server's own constant, not something a caller chooses"
);
assert.ok(
  /drop function if exists public\.deduct_dew_split\(numeric\)/.test(hourSchema) &&
    /drop function if exists public\.deduct_dew\(numeric\)/.test(hourSchema),
  "no per-request charge may survive this migration"
);
assert.ok(
  /drop table public\.hour_sessions/.test(hourSchema),
  "the old per-chat table is dropped, guarded so a second run keeps a live hour"
);
assert.ok(
  /owner uuid primary key/.test(hourSchema) && /free_charged := least\(price, free_left\)/.test(hourSchema),
  "one hour per account, with the free bucket paying first"
);

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
  /charged numeric := 3/.test(pricingSchema),
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
  chatSource.includes("readHourSession"),
  "the chat route must read the account's hour before it answers anything"
);
assert.ok(
  /!coveredBySession/.test(chatSource) && /outOfDewMessage\(\)/.test(chatSource),
  "a message with no live hour is refused, and a covered one is not charged again"
);

// ── The hour is for one model and one repository ────────────────────────────
// The purchase is not a subscription to everything. The row records the model
// and repository it was bought for, and both routes refuse a request that asks
// for another one instead of spending the hour there.

const scopeSchema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261028000300_session_scope.sql"),
  "utf8"
);
const scopeCode = scopeSchema.replace(/--.*$/gm, "");
assert.ok(
  /add column if not exists model text/.test(scopeCode) &&
    /add column if not exists project_id text/.test(scopeCode) &&
    /add column if not exists repo_full_name text/.test(scopeCode),
  "the hour row must remember which model and repository it was bought for"
);
assert.ok(
  /check \(model in \('auto', 'code', 'flash'\)\)/.test(scopeCode),
  "a model the product does not offer must not be storable as an hour's scope"
);
assert.ok(
  /create function public\.start_hour_session\(p_model text default 'auto', p_project_id text default null\)[\s\S]*security definer/.test(
    scopeCode
  ),
  "the start must take the scope and run server-side, not take a price"
);
assert.ok(
  /from public\.projects p[\s\S]*?p\.owner = auth\.uid\(\)[\s\S]*?p\.id = chosen_project/.test(scopeCode),
  "a repository scope must be a project this account actually owns"
);
assert.ok(
  /'model', active\.model/.test(scopeCode) && /'project_id', active\.project_id/.test(scopeCode),
  "a refused second start must carry the live binding, or the interface can only say 'active'"
);

const sessionSource = source(join("app", "api", "session", "route.ts"));
const agentSource = source(join("app", "api", "agent", "step", "route.ts"));
assert.ok(
  /p_model: requestedModel/.test(sessionSource) && /p_project_id: project\?\.id \?\? null/.test(sessionSource),
  "the session route must buy the hour for the requested model and repository"
);
assert.ok(
  sessionSource.includes("session-model-locked") &&
    sessionSource.includes("session-repo-locked") &&
    sessionSource.includes("hourModelRefusal") &&
    sessionSource.includes("hourRepoRefusal"),
  "a live hour for another model or repository must be refused with that binding named"
);
assert.ok(
  /hourSession\.model !== requested/.test(chatSource) && chatSource.includes("hourModelRefusal"),
  "chat must refuse a model the hour was not bought for before it answers"
);
assert.ok(
  /session\.model !== "code"/.test(agentSource) && /session\.projectId !== project\.id/.test(agentSource),
  "the agent must run only on the model and repository the hour was bought for"
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
assert.equal(malaysian.amount, 35, "the converted figure matches the ringgit price");
assert.equal(localPrice(4, "en-MY").amount, 18);
assert.ok(malaysian.formatted.includes("RM"));

// Rounding is a property of the currency, not of its rate. Japan used one rule
// for both plans — ￥600 and ￥1,200 both became ￥1,000 — so the shorter pass
// looked exactly as expensive as the longer one.
assert.equal(currencyForLocale("ja-JP"), "JPY");
assert.equal(localPrice(4, "ja-JP").amount, 600);
assert.equal(localPrice(8, "ja-JP").amount, 1_200);
assert.equal(currencyForLocale("ko-KR"), "KRW");
assert.equal(localPrice(4, "ko-KR").amount, 5_520, "three significant digits keep the converted figure");
assert.equal(localPrice(8, "ko-KR").amount, 11_000);
assert.equal(localPrice(4, "id-ID").amount, 64_000, "rupiah still rounds to the thousand");
assert.equal(localPrice(8, "id-ID").amount, 128_000);

// A region the map has never heard of is answered in dollars, never in an
// invented symbol.
assert.equal(currencyForLocale("en-AQ"), "USD");
const unmapped = localPrice(4, "en-AQ");
assert.equal(unmapped.currency, "USD");
assert.equal(unmapped.amount, 4);
assert.equal(unmapped.approximate, false);

// The added coverage resolves, and each figure stays the shape of a price card
// rather than a number a rate happened to produce.
assert.equal(currencyForLocale("ar-KW"), "KWD");
assert.ok(localPrice(4, "ar-KW").amount > 0 && localPrice(4, "ar-KW").amount < 5);
assert.equal(currencyForLocale("hu-HU"), "HUF");
assert.ok(localPrice(4, "hu-HU").amount >= 1_000 && localPrice(4, "hu-HU").amount <= 2_000);
assert.equal(currencyForLocale("es-CL"), "CLP");
assert.ok(localPrice(4, "es-CL").amount >= 3_000 && localPrice(4, "es-CL").amount <= 5_000);
assert.equal(currencyForLocale("en-KH"), "KHR");
assert.ok(localPrice(8, "en-KH").amount >= 20_000 && localPrice(8, "en-KH").amount <= 60_000);
assert.equal(currencyForLocale("is-IS"), "ISK");
assert.equal(currencyForLocale("en-GH"), "GHS");
assert.equal(currencyForLocale("fr-RE"), "EUR");
