// ── Invitations, as the interface sees them ──────────────────────────────────
//
// The rules live in the database: one code per account, one claim per account,
// no self-referral, ten invitations per referrer, and a fixed reward written by
// the definer. This module only prepares a code for a URL, cleans up what a
// person typed, and turns a refusal into a sentence.
//
// The reward is deliberately the same as `claim_referral()`'s `reward` and the
// UI copy is derived from it, so a change is one edit and a test that compares
// the two cannot drift silently.

export const REFERRAL_DEW = 25;

/** The most successful invitations one account can have. */
export const REFERRAL_LIMIT = 10;

/**
 * Where a code from an invitation link waits while the person signs in.
 *
 * The link lands on `/plus`, but a signed-out visitor is sent to the sign-in
 * screen and may come back on any page. localStorage is what keeps the code
 * alive across that trip; the claim form reads it on the next visit.
 */
export const REFERRAL_STORAGE_KEY = "openmi:referral-code";

/**
 * A code as the claim form and the database will see it.
 *
 * The generated codes are upper-case hex. Anything else a person types is
 * normalised the same way the SQL does (`upper(btrim(...))`): separators and
 * spaces are dropped rather than becoming an error the person cannot see.
 */
export function normalizeReferralCode(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

/** The shareable URL for an account's code. */
export function referralInviteUrl(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/plus?ref=${encodeURIComponent(normalizeReferralCode(code))}`;
}

/**
 * A refusal from the claim RPC, as something worth showing.
 *
 * `raise exception` messages arrive as PostgREST's `message`, so the sentence
 * the SQL wrote is already the best answer. The code branches cover the cases
 * where a policy or a unique constraint rejected the write before the function
 * could explain itself.
 */
export function referralErrorMessage(cause: unknown): string {
  const error = cause as { message?: unknown; code?: unknown } | null;
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  if (error?.code === "23505") return "This account has already used an invitation.";
  if (error?.code === "28000") return "Sign in before claiming an invitation.";
  return "The invitation could not be claimed. Try again.";
}
