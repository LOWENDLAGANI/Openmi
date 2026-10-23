// ── Resolving a claim into Dew, on the server ──────────────────────────────────
//
// The rule this file exists to hold: **a claim says which code, never what it is
// worth.** A `redeems` row carries a word and a timestamp and nothing else. The
// amount is read here, from the code itself, using a token the server verified.
// There is no code path in which a value written by the person claiming decides
// what they receive.
//
// That is the whole difference between this and a balance that can be walked
// through. If the claim could carry `dew: 1000`, then anything able to write a
// claim could write itself a balance, and the amount the database pins on the
// credit write would be checking a value the caller controls.
//
// Why the caller writes the claim at all, rather than the server writing the
// credit: the deployment holds no service key. The policies give the
// administrator write access to `redeem_codes` and deliberately withhold it from
// everyone else, so a visitor cannot mint a code for themselves. So the claim is
// recorded in the caller's own rows — the one thing the policies let them write
// — and the server folds it into their balance.
//
// Termination is enforced twice, on purpose. The policies refuse a claim against
// a switched-off code at write time, so a terminated code stops working for a
// modified client immediately; and `resolveDew` re-checks it on every request, so
// a code terminated *after* it was claimed tops up nothing either. One check
// without the other leaves a hole: the policies alone would keep honouring claims
// made before the switch.

import { ensureTrialGrant, readDewState, writeCredit, type DewState } from "./serverDew";
import {
  checkRedeemable,
  dewRedemptionValue,
  normalizeCode,
  parseRedeemCode,
  type DewRedemption,
} from "./redeemState";
import { clientForToken } from "./supabase";

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

/**
 * Reads one code record with the caller's own token.
 *
 * Not a public read: `redeem_codes` is administrator-only, and the one door for
 * everybody else is `lookup_redeem_code()`, which answers for an exact word and
 * nothing else. Reading it in the caller's company is also the safer
 * arrangement — the server can only resolve a code when somebody has been told
 * it, rather than sweeping the whole table unattended.
 */
async function readCodeAsCaller(authorization: string | null, code: string): Promise<unknown> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client) return null;
  try {
    const { data, error } = await client.rpc("lookup_redeem_code", { p_code: normalizeCode(code) });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return row ?? null;
  } catch {
    return null;
  }
}

/** One claim: which word, and when it was used. */
export interface Claim {
  code: string;
  claimedAt: number;
}

/** The codes this caller has claimed, with the moment each was used. */
export async function readClaimedCodes(authorization: string | null, uid: string): Promise<Claim[]> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return [];
  try {
    const { data, error } = await client
      .from("redeems")
      .select("code, claimed_at")
      .eq("owner", uid);
    if (error || !data) return [];
    const claims: Claim[] = [];
    for (const row of data as Array<{ code?: unknown; claimed_at?: unknown }>) {
      const code = normalizeCode(typeof row.code === "string" ? row.code : "");
      if (code.length === 0) continue;
      const parsed = typeof row.claimed_at === "string" ? Date.parse(row.claimed_at) : NaN;
      claims.push({
        code,
        // A claim with no usable time is anchored to now rather than discarded:
        // it is still a real claim, and discarding it would silently take away a
        // plan somebody was given.
        claimedAt: Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now(),
      });
    }
    return claims;
  } catch {
    return [];
  }
}

/**
 * Every code this caller has claimed, resolved to what each is currently worth.
 *
 * A code that has been terminated, exhausted, deleted, or is otherwise
 * unreadable contributes nothing. A failure to read is treated as "worth
 * nothing" rather than as "worth everything" — the same fail-closed choice
 * `readDewState` makes, and for the same reason: an outage is the one moment the
 * assumption would be wrong in the direction that costs money.
 */
export async function readDewRedemptions(
  authorization: string | null,
  uid: string
): Promise<DewRedemption[]> {
  const claims = await readClaimedCodes(authorization, uid);
  if (claims.length === 0) return [];

  const now = Date.now();
  const values = await Promise.all(
    claims.map(async (claim) => {
      const code = parseRedeemCode(await readCodeAsCaller(authorization, claim.code));
      const status = checkRedeemable(code, now);
      // Only a live Dew code becomes a credit here. A code that was terminated,
      // deleted, or that cannot be read resolves to nothing — the same
      // fail-closed choice every other read in this file makes.
      return status.ok ? dewRedemptionValue(status.code) : null;
    })
  );
  return values.filter((value): value is DewRedemption => value !== null);
}

/**
 * This caller's Dew balance, derived from their credits and their spend.
 *
 * Combines the trial/code credits with any claims on live codes the policies have
 * already accepted, then subtracts what has been spent. A read that fails answers
 * zero — fail-closed, for the same reason every other read here refuses to
 * assume credit.
 */
export async function resolveDew(
  authorization: string | null,
  uid: string
): Promise<DewState> {
  await ensureTrialGrant(authorization, uid);
  const [state, claimed] = await Promise.all([
    readDewState(authorization, uid),
    readDewRedemptions(authorization, uid),
  ]);
  const missing = claimed.filter((entry) => state.credits[entry.code] === undefined);
  if (missing.length === 0) return state;
  await Promise.all(missing.map((entry) => writeCredit(authorization, uid, entry.code, entry.dew)));
  return readDewState(authorization, uid);
}
