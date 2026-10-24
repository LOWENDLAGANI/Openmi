// Dew — the product's pay-as-you-go currency and flat per-request pricing.

import type { ModeId } from "./models";

export const DEW_PER_UNIT = 100; // 100 Dew = $1.00 of value
export const TRIAL_DEW = 25; // granted once at account creation
/** Below this balance a request is refused before it reaches a model. */
export const DUST_THRESHOLD = 0.05;
/** The balance at which the UI chip turns amber, warning of a top-up. */
export const LOW_BALANCE_THRESHOLD = 10;

/** A pack somebody can transfer for, in Dew and ringgit. */
export interface DewPack {
  id: string;
  dew: number;
  ringgit: number;
}
export const DEW_PACKS: readonly DewPack[] = [
  { id: "100", dew: 100, ringgit: 5 },
  { id: "250", dew: 250, ringgit: 10 },
  { id: "500", dew: 500, ringgit: 20 },
  { id: "1000", dew: 1000, ringgit: 35 },
] as const;
/** Same DuitNow QR the rest of the product already uses. */
export const DEW_QR = "/openmi-donate-qr.png";
export const DEW_QR_CAPTION = "Scan with your banking app · DuitNow";
/** Rounding: three decimals is the finest a Dew figure is ever kept. */
export const DEW_PRECISION = 3;

/**
 * The flat price of one completed request, per model.
 *
 * Adding a model means adding one line here. The number is what the request
 * costs, full stop: not a rate, not a per-1,000-token figure, and not something
 * a longer answer changes. `code` is dearer because it is the model tuned for
 * reading and changing a repository, which is the more expensive request to
 * serve.
 */
export const DEW_PER_REQUEST: Record<ModeId, number> = {
  auto: 0.25,
  code: 0.5,
};

export interface TokenUsage {
  prompt: number;
  completion: number;
}

/** The flat price of one request in a given mode. */
export function requestPrice(mode: ModeId): number {
  return DEW_PER_REQUEST[mode] ?? DEW_PER_REQUEST.auto;
}

/** Rounds away float drift so a balance never shows 0.2999999999999998. */
export function roundDew(value: number): number {
  const factor = 10 ** DEW_PRECISION;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Millidew integer — the integer arithmetic unit, so sums never drift. */
export function toMillidew(value: number): number {
  return Math.round(value * 1000);
}

/**
 * Rough token estimate for streams whose provider never reports usage.
 *
 * Tokens no longer decide the bill, but they are still recorded: they are what
 * makes a wrong price visible, and what a future per-model or per-token option
 * would need. The 4-chars-per-token heuristic is deliberately crude; it is only
 * used when the honest number is unavailable.
 */
export function estimateTokenUsage(text: string): TokenUsage {
  return { prompt: 0, completion: Math.ceil(text.length / 4) };
}

/**
 * "RM 35" — a ringgit price as the top-up page prints it: whole ringgit
 * without decimals, anything else to two places.
 */
export function formatRinggit(value: number): string {
  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return `RM ${amount}`;
}

/**
 * "124.5" — a balance as it is shown next to the drop, never more decimals
 * than the currency keeps. A zero balance shows "0" and nothing else.
 */
export function formatDew(value: number): string {
  const rounded = roundDew(value);
  if (rounded === 0) return "0";
  return String(rounded);
}

/** Floor the float sum of credited Dew into a millidew integer. */
export function sumCredits(credits: Record<string, unknown> | null | undefined): number {
  if (!credits) return 0;
  let total = 0;
  for (const value of Object.values(credits)) {
    if (typeof value === "number" && value > 0) total += toMillidew(value);
  }
  return total;
}

/**
 * One account's Dew state, read straight out of the database node.
 *
 * The stored shape is two numbers and a map of credits:
 *   dew/{uid} = { credits: { TRIAL: 25, CODE1: 100 }, spent: 12.375 }
 * The balance is always derived — credits minus spent — never read from a
 * single scalar a client could have written.
 */
export function dewBalanceFrom(
  raw: { credits?: Record<string, number>; spent?: number } | null | undefined
): number {
  if (!raw || typeof raw !== "object") return 0;
  const credits = sumCredits((raw as Record<string, unknown>).credits as Record<string, number>);
  const spent = (raw as Record<string, unknown>).spent;
  const spentValue = typeof spent === "number" && Number.isFinite(spent) && spent > 0 ? toMillidew(spent) : 0;
  return roundDew(Math.max(0, (credits - spentValue) / 1000));
}

/**
 * The rule for writing a spent value: it may only grow for the owner.
 * Encoded here because the routes, the client and the tests must all agree.
 */
export function nextSpent(previous: number, charge: number): number {
  return roundDew(Math.max(0, previous) + Math.max(0, charge));
}

/**
 * True when this balance covers starting a request at `price`.
 *
 * The default is the dust threshold, which keeps the function usable for the
 * "is there any balance at all" question. Routes pass the model's flat price.
 */
export function canAfford(balance: number, price: number = DUST_THRESHOLD): boolean {
  return balance >= price;
}

/** The sentence the chat shows when somebody has run dry. */
export function outOfDewMessage(): string {
  return "**You're out of Dew.** Top up on the /plus page, or redeem a Dew code. Each message costs a fixed amount of Dew for the model you pick, so you can see the price before you send it.";
}
