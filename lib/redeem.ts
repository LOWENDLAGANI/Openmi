// ── Claiming a code ──────────────────────────────────────────────────────────
//
// The visitor types the word and this writes one row: which code they used and
// when. That is the entire payload — no amount, no balance, no expiry.
//
// It is worth being explicit about why, because the tempting version of this file
// would be to read the code, work out what it is worth, and write that into the
// visitor's balance. That version is a paywall with a hole in it: the record
// would then be written by the person claiming, and a bundle edit that wrote
// `amount: 1000` into it would grant exactly that. Here the visitor chooses a
// word and nothing else; the amount comes from the code, and the database itself
// refuses any credit that does not match what the code carries — see
// `dew_credit_allowed()` in supabase/migrations/20261023000500_dew_redeem.sql.
//
// Writing the claim is separate from receiving the credit on purpose. The
// `redeem_codes` table is administrator-only, so a visitor cannot mint a code
// for themselves; the claim is recorded in the visitor's own rows, and the server
// folds it into their balance on every request. The one compromise is the
// credit write below, which the visitor performs so the balance moves without a
// service key — and it is safe precisely because the amount it carries is
// checked against the code by the policy.

import { ensureUser, getSupabase, supabaseConfigured } from "./supabase";
import { isValidCode, normalizeCode, redeemCodeFromRow } from "./redeemState";

export interface ClaimResult {
  ok: boolean;
  /** The word as it was understood, for showing back to the caller. */
  code: string;
  /**
   * True when this code had already been claimed by this account.
   *
   * Reported rather than treated as an error: the top-up is already theirs, and
   * telling somebody their working code is "wrong" would be both untrue and the
   * fastest way to make them ask you for a replacement.
   */
  alreadyClaimed?: boolean;
  /** Why it failed, in a sentence worth showing. */
  error?: string;
}

function notConfigured(): Error & { code?: string } {
  const error = new Error("Openmi is not configured") as Error & { code?: string };
  error.code = "app/not-configured";
  return error;
}

/**
 * Records that this visitor used a code.
 *
 * Returns rather than throws for the ordinary "that word is not one of ours"
 * case, because the visitor is going to be shown that sentence and an exception
 * would make it indistinguishable from a broken deployment.
 *
 * The insert is refused by the policies when the code does not exist or has been
 * switched off — `redeem_code_is_live()` is evaluated on the very write — so a
 * terminated code cannot be claimed by a modified client either. The server
 * checks again on every request for claims that were made before it was off.
 */
export async function claimRedeemCode(rawCode: string): Promise<ClaimResult> {
  const client = getSupabase();
  if (!client) throw notConfigured();
  const user = await ensureUser();
  if (!user) throw notConfigured();

  const code = normalizeCode(rawCode);
  if (!isValidCode(code)) {
    return { ok: false, code, error: "Enter the code exactly as it was given to you." };
  }

  try {
    // The moment this code was claimed, which never changes once it is set.
    //
    // A claim is write-once: `claimed_at` cannot be moved, because a claim that
    // can be rewritten is a claim whose window restarts every time it is typed —
    // which is how one word becomes unlimited time. So this reads first, and
    // only writes when there is genuinely nothing there.
    const existing = await client
      .from("redeems")
      .select("claimed_at")
      .eq("owner", user.id)
      .eq("code", code)
      .maybeSingle();
    if (existing.data) return { ok: true, code, alreadyClaimed: true };

    const claim = await client.from("redeems").insert({ owner: user.id, code });
    if (claim.error) {
      // A duplicate means another tab wrote the same claim first, which is the
      // same outcome as finding it already there.
      if (claim.error.code === "23505") return { ok: true, code, alreadyClaimed: true };
      return {
        ok: false,
        code,
        error: claim.error.message.toLowerCase().includes("row-level security")
          ? "That code cannot be used right now. Ask for a new one."
          : "Openmi could not check that code. Please try again shortly.",
      };
    }

    // A Dew code tops up on the spot: the credit is written with the exact amount
    // the code carries. The policies refuse any other value for this key, so the
    // writer picks only *whether* to claim — the amount is still decided by the
    // code. A claim without a credit is still fine: the server folds it in on the
    // next request through the same rule check.
    const lookup = await client.rpc("lookup_redeem_code", { p_code: code });
    const record = redeemCodeFromRow(Array.isArray(lookup.data) ? lookup.data[0] : lookup.data);
    if (record?.active) {
      await client
        .from("dew_credits")
        .upsert(
          { owner: user.id, code: record.code, amount: record.dew },
          { onConflict: "owner,code", ignoreDuplicates: true }
        );
    }
    return { ok: true, code };
  } catch {
    return {
      ok: false,
      code,
      error: "Openmi could not check that code. Please try again shortly.",
    };
  }
}

/** Whether this visitor has claimed a code, for showing the claim on /plus. */
export async function hasClaimed(rawCode: string): Promise<boolean> {
  if (!supabaseConfigured) return false;
  try {
    const client = getSupabase();
    if (!client) return false;
    const user = await ensureUser();
    if (!user) return false;
    const { data } = await client
      .from("redeems")
      .select("code")
      .eq("owner", user.id)
      .eq("code", normalizeCode(rawCode))
      .maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}
