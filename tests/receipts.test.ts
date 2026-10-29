// ── Receipts, the payment link, and the owner's deduction ────────────────────
//
// Three promises that a build cannot check by compiling:
//
//   * payment is a link to the project's payment page, not a QR drawn in the
//     app — a stray QR would take a payment nobody can reconcile;
//   * a receipt sent from /plus carries the buyer's name and lands in the
//     private bucket, and a saved one is wiped thirty days later;
//   * the console can take Dew back, through a function that checks the admin
//     grant in the database and cannot drive a balance below zero.
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

const schema = read("supabase/migrations/20261029000200_receipts_and_deduct.sql");

test("payment is a link to the payment page, not a QR in the app", () => {
  const dew = read("lib/dew.ts");
  assert.match(
    dew,
    /export const PAYMENT_URL = "https:\/\/sociabuzz\.com\/minetallestmc\/tribe"/,
    "the payment page link is not the project's page"
  );
  assert.ok(!dew.includes("DEW_QR"), "the QR constant is back");

  for (const dialog of ["components/DewPayDialog.tsx", "components/PassPayDialog.tsx"]) {
    const source = read(dialog);
    assert.ok(source.includes("href={PAYMENT_URL}"), `${dialog} does not link to the payment page`);
    assert.ok(source.includes('target="_blank"'), `${dialog} opens the payment page in place`);
    assert.ok(!/openmi-donate-qr|<img/.test(source), `${dialog} still draws a QR/scan image`);
  }

  const plus = read("app/plus/page.tsx");
  assert.ok(!plus.includes("QrDialog"), "the top-up page still mounts a QR dialog");
});

test("a buyer can send a receipt with their name from the top-up page", () => {
  const plus = read("app/plus/page.tsx");
  assert.ok(plus.includes("<ReceiptUpload"), "the top-up page cannot send a receipt");

  const form = read("components/ReceiptUpload.tsx");
  assert.ok(form.includes("payment_receipts"), "the form writes no receipt row");
  assert.ok(form.includes("RECEIPT_BUCKET"), "the form does not use the private bucket");
  assert.ok(form.includes("${user.id}/"), "the file is not stored under the buyer's own folder");
  assert.ok(form.includes("plan_label"), "the receipt does not name the pass it was for");
  assert.match(form, /trimmedName/, "the receipt does not carry a name");
  assert.ok(
    form.includes("the pass is not active yet"),
    "the form must not imply the pass activates on send"
  );
});

test("a receipt is private, and a saved one is wiped after thirty days", () => {
  assert.match(schema, /create table if not exists public\.payment_receipts/, "no receipt table");
  assert.match(schema, /status in \('new', 'saved'\)/, "receipt status is not constrained");
  assert.match(schema, /owner = auth\.uid\(\) or public\.is_admin\(\)/, "receipts are not private to buyer and owner");
  assert.match(
    schema,
    /insert into storage\.buckets[\s\S]*?'receipts',[\s\S]*?false,/,
    "the receipt bucket is not private"
  );
  assert.match(schema, /storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/, "a buyer can write outside their folder");

  const rules = read("lib/receipts.ts");
  assert.match(rules, /export const RECEIPT_RETENTION_DAYS = 30/, "the retention is not thirty days");

  const admin = read("lib/cloudAdmin.ts");
  assert.match(admin, /purgeExpiredReceipts/, "nothing sweeps expired receipts");
  assert.match(admin, /\.remove\(paths\)/, "the saved receipt file is not wiped");
  assert.match(admin, /status: "saved", saved_at: iso\(Date\.now\(\)\)/, "saving does not start the clock");

  const panel = read("components/AdminReceipts.tsx");
  assert.ok(panel.includes("Saved"), "a saved receipt is not labelled saved");
  assert.ok(panel.includes("Wipe"), "the owner cannot wipe a receipt early");
});

test("the owner can deduct Dew, through a function that checks the grant", () => {
  assert.match(
    schema,
    /create or replace function public\.admin_deduct_dew\(p_uid uuid, p_dew numeric\)[\s\S]*?security definer/,
    "the deduction does not run with the rights to write a wallet"
  );
  assert.match(schema, /if not public\.is_admin\(\) then/, "the deduction does not check the admin grant");
  assert.match(
    schema,
    /removed := least\(requested, greatest\(credited - charged, 0\)\)/,
    "the deduction is not clamped to the paid balance"
  );
  assert.match(schema, /revoke all on function public\.admin_deduct_dew\(uuid, numeric\) from public/, "the deduction is public");

  const admin = read("lib/cloudAdmin.ts");
  assert.match(admin, /rpc\("admin_deduct_dew"/, "the console does not call the deduction function");

  const panel = read("components/AdminPanel.tsx");
  assert.ok(panel.includes("deductDew"), "the console cannot deduct");
  assert.ok(panel.includes('{ id: "deduct", label: "Deduct" }'), "the sheet has no deduct mode");
  assert.ok(panel.includes("<AdminReceipts"), "the console cannot review receipts");
});

test("a deduction lands on a wallet that has never spent, and a refusal says why", () => {
  // The bug this guards: `select coalesce(spent, 0) ... into charged` covers a
  // NULL column but not a missing row, so a topped-up buyer who had never bought
  // an hour — no wallet row at all — made `credited - charged` NULL, collapsed
  // the clamp to zero, and was refused the one deduction that was easiest to
  // take back.
  const fix = read("supabase/migrations/20261029000400_deduct_wallet_fix.sql");
  assert.match(
    fix,
    /insert into public\.dew_wallets \(owner, spent, updated_at\)[\s\S]*?on conflict \(owner\) do nothing/,
    "the wallet row is not created before the spend is read"
  );
  assert.match(fix, /select spent into charged/, "the spend is not read from a row that exists");
  assert.match(
    fix,
    /removed := least\(requested, greatest\(credited - charged, 0\)\)/,
    "the deduction is no longer clamped to the paid balance"
  );

  // PostgREST refusals are plain objects, so the console used to print one
  // generic sentence for a missing function, a policy and a constraint alike.
  const admin = read("lib/cloudAdmin.ts");
  assert.match(admin, /export function failureMessage/, "a refused database call has no sentence");
  const panel = read("components/AdminPanel.tsx");
  assert.ok(
    !panel.includes('e instanceof Error ? e.message : "The adjustment did not go through."'),
    "the console is back to a generic sentence for every refusal"
  );
  assert.ok(panel.includes("failureMessage(e, \"The adjustment did not go through.\")"), "the adjustment does not report the database's reason");
});

test("the buyer follows the receipt, and the owner activates the pass from it", () => {
  const form = read("components/ReceiptUpload.tsx");
  assert.ok(form.includes("listMyReceipts"), "the form never reads the buyer's own receipts");
  assert.ok(form.includes("Pending review"), "the buyer cannot see that a receipt is waiting");
  assert.ok(form.includes("Your receipts"), "there is no status list");

  const mine = read("lib/myReceipts.ts");
  assert.match(mine, /\.from\("payment_receipts"\)/, "the buyer list reads no receipts");
  assert.ok(!mine.includes("createSignedUrl"), "the status list must not hand out a private file");

  const panel = read("components/AdminReceipts.tsx");
  assert.ok(panel.includes("grantPlan"), "the owner cannot activate the pass from a receipt");
  assert.ok(panel.includes("Activate"), "there is no activation control");
  assert.match(
    panel,
    /await grantPlan\(receipt\.owner, days\);\s*await savePaymentReceipt\(receipt\.id\);/,
    "activation must grant the pass and then close the receipt"
  );
});

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
