// ── Openmi — tests for redeem codes ────────────────────────────────────────────
//
// A code is a word the owner chooses that carries an amount of Dew. The
// dangerous failure is not that a code stops working — that is a support
// message. It is that a code works for the wrong person, or that somebody
// reaches a balance they were never given. So most of what follows is about the
// claim carrying nothing but a name, and about termination actually terminating.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CODE_MAX,
  checkRedeemable,
  dewRedemptionValue,
  isValidCode,
  normalizeCode,
  parseRedeemCode,
  type RedeemCode,
} from "../lib/redeemState";

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/**
 * A file with its comments stripped.
 *
 * The assertions below look for what code must and must not contain, and a
 * comment *discussing* those things would otherwise fail them — the wrong way
 * round, since explaining why a claim carries no amount is not the same as a
 * claim carrying one.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+$/gm, "");
}

function makeCode(over: Partial<RedeemCode> = {}): RedeemCode {
  return {
    code: "OPENMI-TOPUP",
    dew: 100,
    active: true,
    createdAt: NOW - 1000,
    note: "",
    ...over,
  };
}

// ── The word ─────────────────────────────────────────────────────────────────

// The owner picks it; this only decides how it is written down. Two words that
// differ only in case or spacing must not become two codes a buyer can be given
// by mistake.
assert.equal(normalizeCode("openmi-topup"), "OPENMI-TOPUP");
assert.equal(normalizeCode("OPENMI TOPUP"), "OPENMITOPUP");
assert.equal(normalizeCode("  openmi_topup  "), "OPENMITOPUP");
assert.equal(normalizeCode("m1n0-2026"), "M1N0-2026");
assert.equal(normalizeCode("🚀"), "", "punctuation cannot survive into a code");
assert.ok(normalizeCode("A".repeat(200)).length <= CODE_MAX, "a code is bounded, not unbounded");

// A very short code is one guess away from everybody's, so it is refused before
// it is ever written rather than afterwards.
assert.equal(isValidCode("AB"), false, "two characters is not a code");
assert.equal(isValidCode("OPENMI"), true);
assert.equal(isValidCode(""), false);
assert.equal(isValidCode("   "), false);

// ── Reading what is stored ───────────────────────────────────────────────────

const parsed = parseRedeemCode({
  code: "openmi-topup",
  dew: 250,
  active: true,
  createdAt: NOW,
  note: "  paid by Ana  ",
});
assert.ok(parsed, "a well-formed code parses");
assert.equal(parsed.dew, 250);
assert.equal(parsed.code, "OPENMI-TOPUP", "the stored word is normalized");
assert.equal(parsed.note, "paid by Ana", "a note is trimmed");

// Anything malformed is no code at all, never a half-filled one. An amount that
// cannot be read must not turn into somebody's balance by defaulting to the
// nearest thing that still fits.
assert.equal(parseRedeemCode(null), null);
assert.equal(parseRedeemCode({ code: "OPENMI", active: true, createdAt: NOW }), null, "no amount");
assert.equal(
  parseRedeemCode({ code: "OPENMI", dew: "100", active: true, createdAt: NOW }),
  null,
  "a non-numeric amount is not an amount"
);
assert.equal(parseRedeemCode({ code: "AB", dew: 100, active: true, createdAt: NOW }), null, "too short");
assert.equal(parseRedeemCode({ code: "OPENMI", dew: 100, active: true }), null, "no creation time");

// A missing `active` means created, which is what every code written by the
// console carries. Defaulting the other way would silently kill every code
// whose field went missing.
assert.equal(parseRedeemCode({ code: "OPENMI", dew: 100, createdAt: NOW })?.active, true);
assert.equal(parseRedeemCode({ ...makeCode(), active: false })?.active, false, "off stays off");

// The amount is bounded by the same ceiling the rules validate on the write,
// so a typo in the console cannot mint a fortune.
assert.equal(parseRedeemCode({ code: "OPENMI", dew: 0, active: true, createdAt: NOW }), null, "zero is not a grant");
assert.equal(parseRedeemCode({ code: "OPENMI", dew: -5, active: true, createdAt: NOW }), null, "negative is refused");
assert.equal(
  parseRedeemCode({ code: "OPENMI", dew: 999_999, active: true, createdAt: NOW }),
  null,
  "over the ceiling is refused"
);
assert.equal(
  parseRedeemCode({ code: "OPENMI", dew: 100_000, active: true, createdAt: NOW })?.dew,
  100_000,
  "the ceiling itself passes"
);

// Money keeps three decimals, exactly like a balance.
assert.equal(parseRedeemCode({ code: "OPENMI", dew: 12.3456, active: true, createdAt: NOW })?.dew, 12.346);

// ── The subscription shape is gone ───────────────────────────────────────────
//
// These records still exist in old databases. They must resolve to nothing —
// not to a plan, not to a balance, and not to a code that half works.

const withPlanFields = parseRedeemCode({
  code: "WORD",
  dew: 50,
  plan: "lunar",
  days: 365,
  active: true,
  createdAt: NOW,
});
assert.ok(withPlanFields, "a Dew amount is what makes a record a code");
assert.equal(withPlanFields.dew, 50, "the amount is what it grants");
assert.equal("plan" in withPlanFields, false, "no plan field survives parsing");
assert.equal("days" in withPlanFields, false, "no length field survives parsing");

assert.equal(
  parseRedeemCode({ code: "WORD", plan: "mini", days: 3, active: true, createdAt: NOW }),
  null,
  "the legacy plan code is not a code any more"
);

// ── Terminating ──────────────────────────────────────────────────────────────

assert.equal(checkRedeemable(makeCode(), NOW).ok, true, "a live code redeems");

const off = checkRedeemable(makeCode({ active: false }), NOW);
assert.equal(off.ok, false);
assert.equal(off.ok === false && off.reason, "terminated", "an off code says so");

// There is no use count, and that is a decision rather than an omission.
// Counting redemptions needs a write to `codes/`, which the rules reserve for
// the owner, and this deployment has no service account to do it another way. A
// counter stuck at zero under a console that printed "0/1 used" would be a
// control that looks real and does nothing. The owner's switch is what bounds a
// word.
const counted = makeCode() as RedeemCode & { maxUses?: number; used?: number };
assert.equal(counted.maxUses, undefined, "a code carries no use limit");
assert.equal(counted.used, undefined, "and no use count to display");

const unknown = checkRedeemable(null, NOW);
assert.equal(unknown.ok, false, "an unknown word is not a code");
assert.equal(unknown.ok === false && unknown.reason, "unknown");

// Unlimited is the only behaviour: a code meant as a giveaway must not quietly
// stop at one person.
assert.equal(checkRedeemable(makeCode(), NOW).ok, true, "a code is redeemable by anybody who holds it");

// A code does not expire on its own. Its whole lifetime is the owner's switch,
// and inventing a deadline would invalidate a word mid-handover.
assert.equal(checkRedeemable(makeCode(), NOW + 10 * 365 * DAY_MS).ok, true, "a code does not quietly expire");

// Every refusal carries a sentence worth showing rather than a bare reason.
for (const candidate of [null, makeCode({ active: false })]) {
  const status = checkRedeemable(candidate, NOW);
  assert.ok(status.ok === false && status.message.length > 10, "a refusal must explain itself");
}

// ── What a claim is worth ────────────────────────────────────────────────────

const worth = dewRedemptionValue(makeCode({ dew: 12.5 }));
assert.equal(worth.dew, 12.5, "the amount comes from the code record");
assert.equal(worth.code, "OPENMI-TOPUP");
// The whole point of resolving here rather than in the claim: a caller can name
// a word, and nothing else.
assert.deepEqual(
  Object.keys(worth).sort(),
  ["code", "dew"],
  "a redemption carries the word and the amount, and nothing a caller chose"
);

// ── A claim carries no amount ────────────────────────────────────────────────
//
// The single property the whole feature rests on. If the claim could say what it
// is worth, then whoever can write a claim could write themselves a balance.

// The equivalent of the old rules file is now the schema. These assertions read
// the migration that owns Dew and codes, so the guarantees are still checked
// against the file that actually decides them rather than against a comment
// describing it.
const schema = readFileSync(
  join(process.cwd(), "supabase/migrations/20261023000500_dew_redeem.sql"),
  "utf8"
);

/** The `create table` block for one table. */
function tableBlock(name: string): string {
  const start = schema.indexOf(`create table if not exists public.${name} (`);
  assert.ok(start >= 0, `the ${name} table is missing from the schema`);
  const end = schema.indexOf("\n);", start);
  return schema.slice(start, end);
}

/** Every policy statement for one table. */
function policyBlock(name: string): string {
  return schema
    .split(/\n(?=drop policy|create policy)/)
    .filter((chunk) => chunk.includes(`on public.${name}\n`))
    .join("\n");
}

// The claim's payload is fixed and small. There is no column for an amount, a
// plan, a length or an end date — so a claim literally cannot carry one.
const claimColumns = tableBlock("redeems");
assert.ok(claimColumns.includes("code text not null"), "a claim records which word was used");
assert.ok(claimColumns.includes("claimed_at"), "and when it was used");
assert.ok(!/\bdew\b/.test(claimColumns), "a claim must not be able to carry an amount");
assert.ok(!/\bplan\b/.test(claimColumns), "a claim must not be able to carry a plan");
assert.ok(!/\bdays\b/.test(claimColumns), "a claim must not be able to carry a length");
assert.ok(!/expires/i.test(claimColumns), "a claim must not be able to carry an end date");

// Termination is refused at the moment of writing, so a modified client cannot
// claim against a code the owner has switched off.
const claimPolicies = policyBlock("redeems");
assert.ok(
  /create policy redeems_owner_claim on public\.redeems[\s\S]*public\.redeem_code_is_live\(code\)/.test(
    claimPolicies
  ),
  "the claim refuses the write unless the code is still switched on"
);

// A claim is written once: there is no UPDATE policy for its owner at all, so
// re-typing a code cannot move the moment it was claimed — which is what turned
// one word into unlimited time.
assert.ok(
  !/create policy [a-z_]* on public\.redeems\s+for update/i.test(claimPolicies),
  "a claim's timestamp must be immutable, or redeeming resets the clock"
);

// A credit may only be written for the trial figure or for exactly what a live
// code carries. This is the check that stops a modified client minting a
// balance.
assert.ok(
  /create policy dew_credits_owner_grant on public\.dew_credits[\s\S]*public\.dew_credit_allowed\(code, amount\)/.test(
    schema
  ),
  "a credit write must be checked against the code's own amount"
);
assert.ok(
  /create or replace function public\.dew_credit_allowed[\s\S]*c\.dew = p_amount/.test(schema),
  "the credit check must compare against the stored amount"
);

// ── The codes themselves are the owner's ─────────────────────────────────────

const codePolicies = policyBlock("redeem_codes");
assert.match(
  codePolicies,
  /create policy redeem_codes_admin on public\.redeem_codes\s+for all to authenticated\s+using \(public\.is_admin\(\)\)/,
  "only the owner may create, change or switch off a code"
);
// The owner must still be able to LIST them — the console reads the table. The
// table itself is administrator-only, so a visitor cannot sweep it; the one door
// for everybody else answers for an exact word, which is what the old per-code
// read rule gave.
assert.match(
  codePolicies,
  /create policy redeem_codes_admin on public\.redeem_codes\s+for all to authenticated/,
  "only the owner may list every code"
);
assert.match(
  schema,
  /create or replace function public\.lookup_redeem_code\(p_code text\)[\s\S]*where c\.code = upper\(p_code\)/,
  "a visitor can still fetch one code by the name they were given"
);
assert.ok(
  !/for select to authenticated/.test(codePolicies),
  "a visitor must not be able to select the code table"
);

// A code is a Dew amount and nothing else, checked on the row itself — the
// server and the console both write through this table.
const codeColumns = tableBlock("redeem_codes");
assert.ok(/dew numeric[\s\S]*?not null/.test(codeColumns), "a code must carry a Dew amount");
assert.ok(codeColumns.includes("dew > 0"), "and it must be positive");
assert.ok(codeColumns.includes("<= 100000"), "and under the ceiling");
assert.ok(!/\bplan\b/.test(codeColumns), "no plan-shaped code may be written any more");
assert.ok(!/\bdays\b/.test(codeColumns), "and no length-shaped one either");

// ── The subscription tree is gone ────────────────────────────────────────────
//
// Pay as you go means there is nowhere left for a plan to live. The schema must
// not offer the table, and no source file may still reach for it.

const migrationsDir = join(process.cwd(), "supabase/migrations");
const allSchema = readdirSync(migrationsDir)
  .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
  .join("\n");
assert.ok(
  !/create table[^;]*\bsubscriptions\b/i.test(allSchema),
  "the schema no longer offers a subscriptions table"
);

const forbidden = [
  "useSubscription",
  "subscriptionState",
  "paywallState",
  "paywallServer",
  "lib/plans",
  "lib/durations",
  "resolveEffectivePlan",
  "readCallerPlan",
  "SubscribeGate",
  "PayQrDialog",
  "PlanExpiryBanner",
  "SubscriptionCelebration",
  "/api/plan",
  "grantSubscription",
  "pauseSubscription",
  "resumeSubscription",
  "revokeSubscription",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const scanned = ["app", "components", "lib"].flatMap((dir) => walk(join(process.cwd(), dir)));
for (const file of scanned) {
  const source = readFileSync(file, "utf8");
  for (const token of forbidden) {
    assert.ok(
      !source.includes(token),
      `${file.replace(process.cwd() + "/", "")} still references "${token}"`
    );
  }
}

// ── The client helper writes the claim and nothing else ──────────────────────

const claimSource = readFileSync(join(process.cwd(), "lib", "redeem.ts"), "utf8");
const claimWrite = claimSource.slice(claimSource.indexOf(".from(\"redeems\").insert("));
assert.ok(
  claimWrite.includes("owner: user.id") && claimWrite.includes("code"),
  "the client writes the word and the owner, and nothing else"
);
assert.ok(!/dew:|plan:|days:|expiresAt:/.test(claimWrite), "and nothing that would decide what it is worth");

// An already-claimed code is reported as already claimed, not as an error. The
// top-up is already theirs, and calling a working code "wrong" is the fastest
// way to make somebody ask for a replacement they do not need.
assert.ok(claimSource.includes("alreadyClaimed"), "re-using a code must be reported as success, with the reason");
assert.ok(
  /\.from\("redeems"\)\s*\n?\s*\.select\("claimed_at"\)/.test(claimSource),
  "the client must read the claim before writing it, so it does not reset the clock"
);

// ── The server resolves from the code, fail-closed ───────────────────────────
//
// The reader re-checks `active` on every request rather than trusting a claim
// made while the code was on, and it reads with the caller's own token so the
// rules judge it exactly as they judge the browser.

const resolver = code(join(process.cwd(), "lib", "serverRedeem.ts"));
assert.ok(resolver.includes("checkRedeemable("), "every code must be re-checked for termination on each request");
assert.ok(
  resolver.includes("clientForToken(token)") && resolver.includes('rpc("lookup_redeem_code"'),
  "the code read must be made with the caller's token so the policies judge it"
);
assert.ok(resolver.includes("dewRedemptionValue("), "a claim resolves to the amount on the code");
assert.ok(!resolver.includes("planId"), "and never to a plan");
// A read that fails is worth nothing. The comment says so; the code must do it.
assert.ok(
  resolver.includes("values.filter((value): value is DewRedemption => value !== null)"),
  "an unreadable code contributes nothing rather than everything"
);

// ── The interface reads the balance, not a plan ──────────────────────────────
//
// The buyer's side used to watch `subscriptions/`, which a claim never writes,
// so a code that worked was followed by a screen that said Free. Now there is
// one number: the balance, read from the same derivation the routes enforce.

const redeemBox = code(join(process.cwd(), "components", "RedeemCodeBox.tsx"));
assert.ok(redeemBox.includes("useDew("), "the redeem box reads the shared balance store");
assert.ok(/await refresh\(\)/.test(redeemBox), "and re-reads it the moment a code lands");

console.log("redeem: all checks passed");
