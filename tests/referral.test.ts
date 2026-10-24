// ── Tests for the invitation loop ────────────────────────────────────────────
//
// Dew is money, so the referral rules are tested where they live: the database.
// The interface half — normalising a code, building the link, turning a refusal
// into a sentence — is pure and pinned here too.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REFERRAL_DEW,
  REFERRAL_LIMIT,
  normalizeReferralCode,
  referralErrorMessage,
  referralInviteUrl,
} from "../lib/referral";

// ── Codes ────────────────────────────────────────────────────────────────────

assert.equal(normalizeReferralCode("  ab-c d  "), "ABCD");
assert.equal(normalizeReferralCode("a".repeat(40)).length, 16);
assert.equal(normalizeReferralCode(null), "");
assert.equal(normalizeReferralCode(42), "");

assert.equal(
  referralInviteUrl("https://openmi.example/", "ABCD1234"),
  "https://openmi.example/plus?ref=ABCD1234"
);
assert.equal(
  referralInviteUrl("https://openmi.example", "ab cd"),
  "https://openmi.example/plus?ref=ABCD"
);

// ── Refusals ─────────────────────────────────────────────────────────────────

assert.equal(
  referralErrorMessage({ message: "This account has already used an invitation." }),
  "This account has already used an invitation."
);
assert.equal(
  referralErrorMessage({ code: "23505" }),
  "This account has already used an invitation."
);
assert.equal(referralErrorMessage({ code: "28000" }), "Sign in before claiming an invitation.");
assert.equal(referralErrorMessage(null), "The invitation could not be claimed. Try again.");
assert.equal(referralErrorMessage({ message: "   " }), "The invitation could not be claimed. Try again.");

// ── The rules in the database ───────────────────────────────────────────────

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20261024000600_referrals.sql"),
  "utf8"
);

assert.match(sql, /create table if not exists public\.referral_codes/);
assert.match(sql, /create table if not exists public\.referrals/);
assert.ok(
  /referred uuid primary key/.test(sql),
  "the referred uid must be the primary key: one invitation per account"
);
assert.ok(/check \(referred <> owner\)/.test(sql), "self-referral must be refused by the table too");
assert.ok(
  /reward numeric := 25/.test(sql) && REFERRAL_DEW === 25,
  "the reward in SQL must match REFERRAL_DEW"
);
assert.ok(
  /invite_limit integer := 10/.test(sql) && REFERRAL_LIMIT === 10,
  "the invitation cap in SQL must match REFERRAL_LIMIT"
);
assert.ok(/if used >= invite_limit then/.test(sql), "the cap must be checked before the reward is written");
assert.ok(/for update/.test(sql), "two simultaneous claims must serialise against the cap");
assert.ok(
  /insert into public\.dew_credits[\s\S]*REFERRAL-[\s\S]*on conflict \(owner, code\) do nothing/.test(sql),
  "a referrer's reward must be write-once per invitee"
);
assert.ok(
  /REFERRAL-WELCOME[\s\S]*on conflict \(owner, code\) do nothing/.test(sql),
  "the joining account's reward must be write-once"
);
assert.ok(
  /create or replace function public\.claim_referral\(p_code text\)[\s\S]*security definer/.test(sql),
  "claiming must run as the definer so the claimant cannot name the amount"
);
assert.ok(
  /revoke all on function public\.claim_referral\(text\) from public/.test(sql) &&
    /grant execute on function public\.claim_referral\(text\) to authenticated/.test(sql),
  "only a signed-in account may claim"
);
assert.ok(
  /grant select on public\.referral_codes to authenticated/.test(sql) &&
    !/grant (insert|update|delete)[^;]*on public\.referrals to authenticated/.test(sql),
  "a referral is readable, never writable by the browser"
);

// ── The audit is now table-driven ───────────────────────────────────────────

assert.match(sql, /create table if not exists public\.schema_expected/);
assert.match(sql, /from public\.schema_expected e/);
assert.ok(sql.includes("'claim_referral(text)'"), "the audit must know about the claim function");
assert.ok(sql.includes("'referral_codes'") && sql.includes("'referrals'"));
assert.ok(
  /grant execute on function public\.openmi_schema_health\(\) to anon, authenticated/.test(sql),
  "the public health check must stay public"
);

console.log("referral: all checks passed");
