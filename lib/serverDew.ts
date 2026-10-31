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
  DAILY_FREE_DEW,
  DEW_RESET_TIME_ZONE,
  DUST_THRESHOLD,
  TRIAL_DEW,
  canAfford as balanceCovers,
  dailyAllowance,
  dailyDewRemaining,
  dewBalanceFrom,
  dewDay,
  isSupportedTimeZone,
  roundDew,
  toMillidew,
  type TokenUsage,
} from "./dew";
import { clientForToken } from "./supabase";
import type { ModeId } from "./models";

export interface DewState {
  /** What can be spent now: paid Dew plus today's unused free Dew. */
  balance: number;
  /** Paid credits minus spend, without the free daily allotment. */
  paidBalance: number;
  /** Free Dew still available today; resets at midnight in the reset zone. */
  dailyRemaining: number;
  /** Free Dew granted at the start of every day: 10 free, 15 with a pass. */
  dailyAllowance: number;
  /** When the paid pass ends, epoch ms, or null when there is none. */
  paidUntil: number | null;
  /** True when a paid pass is live right now. */
  paid: boolean;
  /** The IANA zone this account's day turns over in. */
  timeZone: string;
  credits: Record<string, number>;
  spent: number;
}

// A failed or unidentifiable read grants nothing — not even the daily bucket.
const EMPTY: DewState = {
  balance: 0,
  paidBalance: 0,
  dailyRemaining: 0,
  dailyAllowance: DAILY_FREE_DEW,
  paidUntil: null,
  paid: false,
  timeZone: DEW_RESET_TIME_ZONE,
  credits: {},
  spent: 0,
};

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

/** Epoch ms from a timestamptz the database returned, or 0. */
function timestamp(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
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
    // The pass lives in its own select-only table, so this read can be refused
    // by a project that has not applied 20261028000000_pricing_sessions.sql
    // without costing the balance: no readable pass is a free account.
    const [credits, profile, pass] = await Promise.all([
      client.from("dew_credits").select("code, amount").eq("owner", uid),
      client.from("profiles").select("timezone").eq("id", uid).maybeSingle(),
      client.from("paid_passes").select("expires_at").eq("owner", uid).maybeSingle(),
    ]);
    if (credits.error) return EMPTY;

    // Before 20261024000300_dew_timezone.sql the column does not exist; the
    // default zone is what the database used in that window too.
    const storedZone = (profile.data as { timezone?: unknown } | null)?.timezone;
    const timeZone = isSupportedTimeZone(storedZone) ? storedZone : DEW_RESET_TIME_ZONE;
    const paidUntilMs = timestamp((pass.data as { expires_at?: unknown } | null)?.expires_at);
    const isPaid = paidUntilMs > Date.now();
    const allowance = dailyAllowance(isPaid);

    // The daily bucket arrives with 20261024000200_daily_dew.sql. If this code
    // reaches a project before that migration, fall back to the paid-only
    // wallet rather than reporting a zero balance to every account.
    let spent = 0;
    let dailyDay: string | null = null;
    let dailySpent = 0;
    let dailyTracked = true;
    const wallet = await client
      .from("dew_wallets")
      .select("spent, daily_day, daily_spent")
      .eq("owner", uid)
      .maybeSingle();
    if (wallet.error) {
      dailyTracked = false;
      const legacy = await client
        .from("dew_wallets")
        .select("spent")
        .eq("owner", uid)
        .maybeSingle();
      if (legacy.error) return EMPTY;
      spent = Number(legacy.data?.spent ?? 0);
    } else {
      const row = wallet.data as { spent?: unknown; daily_day?: unknown; daily_spent?: unknown } | null;
      spent = Number(row?.spent ?? 0);
      dailyDay = typeof row?.daily_day === "string" ? row.daily_day : null;
      dailySpent = Number(row?.daily_spent ?? 0);
    }

    const map: Record<string, number> = {};
    for (const row of (credits.data ?? []) as Array<{ code?: unknown; amount?: unknown }>) {
      if (typeof row.code !== "string") continue;
      const value = Number(row.amount);
      if (Number.isFinite(value) && value > 0 && value <= 1_000_000) {
        map[normalizeCreditKey(row.code)] = value;
      }
    }
    const paid = Number.isFinite(spent) && spent > 0 ? spent : 0;
    const paidBalance = dewBalanceFrom({ credits: map, spent: paid });
    const dailyRemaining = dailyTracked
      ? dailyDewRemaining({ dailyDay, dailySpent }, dewDay(Date.now(), timeZone), allowance)
      : 0;
    return {
      balance: roundDew(paidBalance + dailyRemaining),
      paidBalance,
      dailyRemaining,
      dailyAllowance: allowance,
      paidUntil: paidUntilMs > 0 ? paidUntilMs : null,
      paid: isPaid,
      timeZone,
      credits: map,
      spent: paid,
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
 * Deducts the cost of one request and says how it was paid for.
 *
 * `deduct_dew_split()` adds to the caller's own wallet in one locked statement
 * and reports the spent total plus the free/paid halves. The uid comes from the
 * token, so the only wallet it can touch is the caller's own. `newSpent` comes
 * back from the database rather than from the value the route computed, which
 * is what makes the caller's view of the ledger agree with the stored one even
 * when two requests overlap.
 *
 * A deployment without 20261024000500_dew_activity.sql still has
 * `deduct_dew()`; the fallback charges through it and attributes the whole
 * amount to paid credit rather than refusing to bill. The activity history then
 * shows the charge without a split, which is the honest answer for rows that
 * never had one.
 */
export async function deductDew(
  authorization: string | null,
  uid: string,
  previousSpent: number,
  charge: number
): Promise<{
  ok: boolean;
  newSpent: number;
  freeCharged: number;
  paidCharged: number;
  conflict: boolean;
  fallback?: boolean;
  reason?: string;
}> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) {
    return {
      ok: false,
      newSpent: previousSpent,
      freeCharged: 0,
      paidCharged: 0,
      conflict: false,
      reason: "unconfigured",
    };
  }
  if (charge <= 0) {
    return { ok: true, newSpent: previousSpent, freeCharged: 0, paidCharged: 0, conflict: false };
  }

  const amount = roundDew(charge);
  try {
    const split = await client.rpc("deduct_dew_split", { p_amount: amount });
    if (!split.error) {
      const row = (Array.isArray(split.data) ? split.data[0] : split.data) as {
        spent?: unknown;
        free_charged?: unknown;
        paid_charged?: unknown;
      } | null;
      const spent = Number(row?.spent);
      const freeCharged = Number(row?.free_charged);
      const paidCharged = Number(row?.paid_charged);
      return {
        ok: true,
        newSpent: Number.isFinite(spent) ? spent : previousSpent,
        freeCharged: Number.isFinite(freeCharged) && freeCharged > 0 ? freeCharged : 0,
        paidCharged: Number.isFinite(paidCharged) && paidCharged > 0 ? paidCharged : 0,
        conflict: false,
      };
    }

    // PGRST202: the split function is not in the project yet. Keep billing
    // through the original door instead of losing the charge.
    if ((split.error as { code?: string }).code !== "PGRST202") {
      return {
        ok: false,
        newSpent: previousSpent,
        freeCharged: 0,
        paidCharged: 0,
        conflict: false,
        reason: split.error.message,
      };
    }

    const legacy = await client.rpc("deduct_dew", { p_amount: amount });
    if (legacy.error) {
      return {
        ok: false,
        newSpent: previousSpent,
        freeCharged: 0,
        paidCharged: 0,
        conflict: false,
        reason: legacy.error.message,
      };
    }
    const newSpent = Number(legacy.data);
    return {
      ok: true,
      newSpent: Number.isFinite(newSpent) ? newSpent : previousSpent,
      freeCharged: 0,
      paidCharged: amount,
      conflict: false,
      fallback: true,
    };
  } catch (error) {
    return {
      ok: false,
      newSpent: previousSpent,
      freeCharged: 0,
      paidCharged: 0,
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
    /** The part paid from today's free bucket. */
    free?: number;
    at?: number;
  }
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  const at = line.at ?? Date.now();
  const dew = roundDew(Math.max(0, line.dew));
  // The split always sums to the price. `free` is the only input; paid is the
  // remainder, so a caller cannot write a row whose parts exceed the charge.
  const free = roundDew(Math.min(Math.max(0, line.free ?? 0), dew));
  const paid = roundDew(dew - free);
  const payload = {
    id: `${at}-${Math.random().toString(36).slice(2, 8)}`,
    owner: uid,
    type: "usage",
    at: new Date(at).toISOString(),
    dew,
    model: line.model ?? null,
    prompt: line.prompt ?? null,
    completion: line.completion ?? null,
    repo: line.repo ?? null,
    free_dew: free,
    paid_dew: paid,
  };
  try {
    const { error } = await client.from("dew_transactions").insert(payload);
    if (!error) return true;
    // PGRST204: the activity migration is not applied yet. Keep the history by
    // writing the columns the original table has; the split is simply absent.
    if ((error as { code?: string }).code !== "PGRST204") return false;
    const retry = await client.from("dew_transactions").insert({
      id: payload.id,
      owner: payload.owner,
      type: payload.type,
      at: payload.at,
      dew: payload.dew,
      model: payload.model,
      prompt: payload.prompt,
      completion: payload.completion,
      repo: payload.repo,
    });
    return !retry.error;
  } catch {
    return false;
  }
}

/** One row of the spend history, normalised for the activity page. */
export interface DewTransactionLine {
  at: number;
  dew: number;
  model: string | null;
  prompt: number | null;
  completion: number | null;
  repo: string | null;
  /** The part paid from the free daily bucket. */
  free: number;
  paid: number;
}

/** One credit row, for the "earned" side of the history. */
export interface DewCreditLine {
  at: number;
  code: string;
  amount: number;
}

/** Epoch milliseconds from a PostgREST timestamp, or 0 when unusable. */
function epoch(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * This caller's request history, oldest first.
 *
 * The split columns arrive with 20261024000500_dew_activity.sql; before that,
 * the fallback read keeps the history visible and simply reports every charge as
 * paid. A failed read is an empty history, never an invented one.
 */
export async function readDewTransactions(
  authorization: string | null,
  uid: string,
  since: number
): Promise<DewTransactionLine[]> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return [];
  const from = new Date(since).toISOString();
  const base = () =>
    client
      .from("dew_transactions")
      .select("at, dew, model, prompt, completion, repo")
      .eq("owner", uid)
      .gte("at", from)
      .order("at", { ascending: true })
      .limit(1000);

  try {
    const full = await client
      .from("dew_transactions")
      .select("at, dew, model, prompt, completion, repo, free_dew")
      .eq("owner", uid)
      .gte("at", from)
      .order("at", { ascending: true })
      .limit(1000);

    let rows: Record<string, unknown>[];
    if (!full.error) {
      rows = (full.data ?? []) as Record<string, unknown>[];
    } else if ((full.error as { code?: string }).code === "PGRST204") {
      const legacy = await base();
      if (legacy.error) return [];
      rows = (legacy.data ?? []) as Record<string, unknown>[];
    } else {
      return [];
    }

    return rows
      .map((row) => {
        const dew = roundDew(Math.max(0, Number(row.dew) || 0));
        const free = roundDew(Math.min(Math.max(0, Number(row.free_dew) || 0), dew));
        return {
          at: epoch(row.at),
          dew,
          model: typeof row.model === "string" ? row.model : null,
          prompt: Number.isFinite(Number(row.prompt)) ? Number(row.prompt) : null,
          completion: Number.isFinite(Number(row.completion)) ? Number(row.completion) : null,
          repo: typeof row.repo === "string" ? row.repo : null,
          free,
          paid: roundDew(dew - free),
        };
      })
      .filter((row) => row.at > 0 && row.dew > 0);
  } catch {
    return [];
  }
}

/** Credits added in the window, for the "earned" side of the page. */
export async function readDewCredits(
  authorization: string | null,
  uid: string,
  since: number
): Promise<DewCreditLine[]> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return [];
  try {
    const { data, error } = await client
      .from("dew_credits")
      .select("code, amount, created_at")
      .eq("owner", uid)
      .gte("created_at", new Date(since).toISOString())
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) return [];
    return ((data ?? []) as Record<string, unknown>[])
      .map((row) => ({
        at: epoch(row.created_at),
        code: typeof row.code === "string" ? row.code : "",
        amount: roundDew(Math.max(0, Number(row.amount) || 0)),
      }))
      .filter((row) => row.at > 0 && row.amount > 0 && row.code.length > 0);
  } catch {
    return [];
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
