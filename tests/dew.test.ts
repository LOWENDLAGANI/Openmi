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
  DEW_PACKS,
  DEW_PER_REQUEST,
  DEW_PER_UNIT,
  DUST_THRESHOLD,
  LOW_BALANCE_THRESHOLD,
  canAfford,
  dewBalanceFrom,
  estimateTokenUsage,
  formatDew,
  nextSpent,
  requestPrice,
  roundDew,
  sumCredits,
  toMillidew,
} from "../lib/dew";
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
