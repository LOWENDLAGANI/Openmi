// ── Dew on the server ────────────────────────────────────────────────────────
//
// The deployment holds no service key, so — exactly like every other privileged
// thing this app does — the server only ever touches the data with a token it has
// itself verified, and the policies judge that token.
//
// Two things changed shape when this moved from the Realtime Database, and both
// are improvements rather than compromises:
//
//   1. The balance is no longer one writable node. `dew_credits` holds the
//      credits, `dew_wallets` holds the spend, and the policies let a caller
//      *read* their own and insert a credit only when the code it names is worth
//      exactly that. A modified client cannot write itself a balance.
//   2. `spent` is incremented by `deduct_dew()` in one statement. The old build
//      needed an ETag dance because REST had no transactions; a conditional write
//      that lost the race dropped the charge, and a fallback plain write could
//      fold a concurrent charge in early. Postgres just adds, so two overlapping
//      requests cannot lose a charge or double one.
//
// A failed charge is logged by the caller rather than retried here: retrying
// inside a streaming response cannot be made reliable, and an over-charge is
// worse than an under-charge the caller can see.

import {
  DUST_THRESHOLD,
  TRIAL_DEW,
  canAfford as balanceCovers,
  dewBalanceFrom,
  roundDew,
  toMillidew,
  type TokenUsage,
} from "./dew";
import { clientForToken } from "./supabase";
import type { ModeId } from "./models";

export interface DewState {
  /** Credits minus spent, in Dew, floored at zero. */
  balance: number;
  credits: Record<string, number>;
  spent: number;
}

const EMPTY: DewState = { balance: 0, credits: {}, spent: 0 };

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

/** Keys are upper-case words and the reserved meta keys. */
function normalizeCreditKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40) || "UNKNOWN";
}

/**
 * Reads this caller's Dew with their own token.
 *
 * A refused or failed read is a zero balance, never an assumption of credit:
 * fail-closed, because the only safe answer to "I could not check" is to grant
 * nobody anything. An unconfigured deployment has no balances, and nobody is
 * charged.
 */
export async function readDewState(authorization: string | null, uid: string): Promise<DewState> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return EMPTY;

  try {
    const [credits, wallet] = await Promise.all([
      client.from("dew_credits").select("code, amount").eq("owner", uid),
      client.from("dew_wallets").select("spent").eq("owner", uid).maybeSingle(),
    ]);
    if (credits.error || wallet.error) return EMPTY;

    const map: Record<string, number> = {};
    for (const row of (credits.data ?? []) as Array<{ code?: unknown; amount?: unknown }>) {
      if (typeof row.code !== "string") continue;
      const value = Number(row.amount);
      if (Number.isFinite(value) && value > 0 && value <= 1_000_000) {
        map[normalizeCreditKey(row.code)] = value;
      }
    }
    const spent = Number(wallet.data?.spent ?? 0);
    return {
      balance: dewBalanceFrom({ credits: map, spent }),
      credits: map,
      spent: Number.isFinite(spent) && spent > 0 ? spent : 0,
    };
  } catch {
    return EMPTY;
  }
}

/** True when this caller has enough Dew to start a request at `floor`. */
export function canAfford(state: DewState, floor: number = DUST_THRESHOLD): boolean {
  return balanceCovers(state.balance, floor);
}

/**
 * Writes one credit with the caller's token.
 *
 * Refused by the policies unless the amount is the trial figure or exactly what a
 * live code carries, and refused again if the key already exists — a credit is
 * write-once, which is what stops a replayed claim from stacking. `ignoreDuplicates`
 * makes the second case a no-op rather than an error, so a retry is safe.
 */
export async function writeCredit(
  authorization: string | null,
  uid: string,
  key: string,
  amount: number
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  const creditKey = normalizeCreditKey(key);
  if (!client || !uid || creditKey === "UNKNOWN") return false;

  try {
    const { error } = await client
      .from("dew_credits")
      .upsert(
        { owner: uid, code: creditKey, amount: roundDew(amount) },
        { onConflict: "owner,code", ignoreDuplicates: true }
      );
    return !error;
  } catch {
    return false;
  }
}

/**
 * Ensures the trial balance exists, exactly once.
 *
 * Called from `/api/dew` on a verified session. The primary key is what makes it
 * once: a replayed call collides with the row it already wrote and changes
 * nothing, where the Realtime Database needed a rule comparing `data` with
 * `newData`. The amount is pinned by `dew_credit_allowed()` either way, so a
 * modified client cannot mint credits of its own choosing.
 */
export async function ensureTrialGrant(
  authorization: string | null,
  uid: string
): Promise<{ ok: boolean; alreadyGranted: boolean }> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return { ok: false, alreadyGranted: false };

  try {
    const existing = await client
      .from("dew_credits")
      .select("code")
      .eq("owner", uid)
      .eq("code", "TRIAL")
      .maybeSingle();
    if (existing.error) return { ok: false, alreadyGranted: false };
    if (existing.data) return { ok: true, alreadyGranted: true };

    const written = await client
      .from("dew_credits")
      .upsert(
        { owner: uid, code: "TRIAL", amount: TRIAL_DEW },
        { onConflict: "owner,code", ignoreDuplicates: true }
      );
    if (written.error) return { ok: false, alreadyGranted: false };
    return { ok: true, alreadyGranted: false };
  } catch {
    return { ok: false, alreadyGranted: false };
  }
}

/**
 * Deducts the cost of one request and answers the new total.
 *
 * `deduct_dew()` adds to the caller's own wallet in one statement; the function
 * carries the uid, so the only wallet it can touch is the one the token belongs
 * to. `newSpent` comes back from the database rather than from the value the
 * route computed, which is what makes the caller's view of the ledger agree with
 * the stored one even when two requests overlap.
 */
export async function deductDew(
  authorization: string | null,
  uid: string,
  previousSpent: number,
  charge: number
): Promise<{ ok: boolean; newSpent: number; conflict: boolean; fallback?: boolean; reason?: string }> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) {
    return { ok: false, newSpent: previousSpent, conflict: false, reason: "unconfigured" };
  }
  if (charge <= 0) return { ok: true, newSpent: previousSpent, conflict: false };

  try {
    const { data, error } = await client.rpc("deduct_dew", { p_amount: roundDew(charge) });
    if (error) {
      return { ok: false, newSpent: previousSpent, conflict: false, reason: error.message };
    }
    const newSpent = Number(data);
    return {
      ok: true,
      newSpent: Number.isFinite(newSpent) ? newSpent : previousSpent,
      conflict: false,
    };
  } catch (error) {
    return {
      ok: false,
      newSpent: previousSpent,
      conflict: false,
      reason: error instanceof Error ? error.message : "threw",
    };
  }
}

/**
 * Appends one line to the request ledger.
 *
 * Best effort: a refused write costs the history, never the balance. The policy
 * accepts only `type = 'usage'` rows with a positive charge, so this cannot be
 * used to write an arbitrary number into somebody's record.
 */
export async function recordDewTransaction(
  authorization: string | null,
  uid: string,
  line: {
    dew: number;
    model?: string | null;
    prompt?: number;
    completion?: number;
    repo?: string | null;
    at?: number;
  }
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  const at = line.at ?? Date.now();
  try {
    const { error } = await client.from("dew_transactions").insert({
      id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
      owner: uid,
      type: "usage",
      at: new Date(at).toISOString(),
      dew: roundDew(line.dew),
      model: line.model ?? null,
      prompt: line.prompt ?? null,
      completion: line.completion ?? null,
      repo: line.repo ?? null,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * The record for the console and the ledger. Never shown to the caller.
 *
 * The price is passed in rather than derived from the tokens: a request costs a
 * flat amount for the model it ran on. The usage is kept beside it so the admin
 * can still see what the money actually bought.
 */
export interface DewChargeLine {
  model: ModeId;
  usage: TokenUsage;
  dew: number;
}

export function recordChargeLine(model: ModeId, usage: TokenUsage, dew: number): DewChargeLine {
  return { model, usage, dew };
}

/** Millidew total of credits, for the ledger the console prints. */
export function creditsTotal(credits: Record<string, number>): number {
  let total = 0;
  for (const value of Object.values(credits)) total += toMillidew(value);
  return total / 1000;
}
