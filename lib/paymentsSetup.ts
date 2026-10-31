// ── Can this deployment take a payment at all? ───────────────────────────────
//
// `openmi_schema_health()` names the migration behind every missing table, but it
// has one blind spot that matters more than any other: the audit can only report
// an object whose migration has already registered it in `schema_expected`. A
// project that never ran `20261029000200_receipts_and_deduct` has no
// `schema_expected` rows from that file either — so the one deployment that needs
// to be told "this migration is pending" is the one the audit cannot name.
//
// That is exactly the state a buyer meets. They open the top-up page, pay, and
// the receipt form cannot store anything; the owner opens the console and the
// deduction does not exist. Neither screen could tell them why.
//
// This module is the direct probe that closes it: ask the table itself. It holds
// no client and makes no request — the component owns the call — so the rule
// below is a pure function that can be tested against real PostgREST errors.
//
// The migration carries both halves of a manual sale, which is why one probe
// answers for both: `payment_receipts` (the proof a buyer sends) and
// `admin_deduct_dew()` (the owner taking Dew back).

/** The migration a deployment needs before it can take or settle a payment. */
export const PAYMENTS_MIGRATION = "20261029000200_receipts_and_deduct";

/** The command that applies it, shown to the owner instead of a PostgREST code. */
export const PAYMENTS_APPLY_COMMAND = "supabase db push";

/** What stops working while it is pending, in one sentence. */
export const PAYMENTS_GAP_SUMMARY =
  "A buyer cannot send a receipt, and the console cannot deduct Dew, until this migration is applied.";

/**
 * True when a failed read means the table is absent, rather than refused.
 *
 * The distinction is the whole point. `payment_receipts` is readable only by its
 * owner and the administrator, so a refusal (42501) is proof the table exists and
 * must never be reported as a missing migration. A table that was never created
 * answers with PostgREST's PGRST205 schema-cache error, or Postgres' 42P01, and
 * either one is the gap this notice exists for.
 */
export function paymentsSchemaGap(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const error = cause as { code?: unknown; message?: unknown; details?: unknown };
  const code = typeof error.code === "string" ? error.code : "";
  if (code === "PGRST205" || code === "42P01") return true;
  const text = `${typeof error.message === "string" ? error.message : ""} ${
    typeof error.details === "string" ? error.details : ""
  }`;
  // Some PostgREST builds answer 404 with the sentence and no code at all.
  return /could not find the table|relation .*payment_receipts.* does not exist|undefined table|schema cache/i.test(
    text
  );
}
