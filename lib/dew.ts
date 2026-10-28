// ── Dew — the product's pay-as-you-go currency ────────────────────────────────
// Pure logic only: no database, no fetch. Everything about what a request costs,
// what a balance means, and what a balance looks like on screen is decided here,
// so the routes, the client and the tests cannot drift apart.
//
// One Dew is 1/100 of a US dollar in value. Balances are held and computed in
// exactly three decimal places and stored rounded to that, so a balance a client
// computes from the same node the server read is the same balance the server
// enforced with.
//
// ── Billing by the hour ───────────────────────────────────────────────────────
// Usage is bought in one-hour sessions, not per message. Three Dew opens an hour
// that covers every answer in every chat, on every model; a request itself costs
// nothing, so the price of a conversation is known before it starts. Tokens are
// still counted and reported, but they are telemetry, not the bill.
//
// One unit for everything is deliberate: chat and the repository agent draw on the
// same hour, so there is one number to understand and one place it is charged —
// `start_hour_session()`.

export const DEW_PER_UNIT = 100; // 100 Dew = $1.00 of value
export const TRIAL_DEW = 5; // granted once at account creation
/**
 * Free Dew every account is given at the start of each day.
 *
 * The allotment is a bucket, not a stipend that accumulates: what is left at
 * midnight is discarded and the bucket is full again, so it can never be saved
 * up into a paid-sized balance. It is spent before any paid credit.
 */
export const DAILY_FREE_DEW = 10;
/**
 * The bucket a paid account gets instead.
 *
 * A paid pass is not a new kind of currency: it raises the same daily bucket,
 * which keeps one rule for "what can I spend today" and one place the database
 * and the server read it from.
 */
export const PAID_DAILY_FREE_DEW = 15;
/**
 * The zone the day turns over in when the account has not named its own.
 *
 * The product prices in ringgit, so Kuala Lumpur is the sensible fallback for
 * an account whose browser never reported a zone. A registered account stores
 * its own IANA zone on `profiles.timezone` (see `set_profile_timezone()` in
 * 20261024000300_dew_timezone.sql), and that is the zone the database and the
 * server both use from then on. This constant is also the fallback in
 * `deduct_dew()` when the stored zone is missing or not recognised.
 */
export const DEW_RESET_TIME_ZONE = "Asia/Kuala_Lumpur";
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
 * The one price: three Dew buys an hour of usage.
 *
 * There is no per-request charge. An hour covers every answer in every chat, on
 * every model, so a person pays for time and not for how much the model writes —
 * which is the one price that is predictable before a conversation starts.
 */
export const DEW_PER_HOUR = 3;

/** One session lasts this long from the moment the server starts it. */
export const HOUR_SESSION_MS = 60 * 60 * 1000;

export interface TokenUsage {
  prompt: number;
  completion: number;
}

const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** One ISO-date formatter per zone, built once. */
function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DAY_FORMATTERS.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  DAY_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/**
 * True when the runtime understands this IANA zone.
 *
 * The zone arrives from the browser and from `profiles.timezone`, so it is
 * always treated as untrusted: `Intl` is the judge, and an unknown zone is
 * simply not used.
 */
export function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    dayFormatter(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The day the free Dew belongs to at `at`, as YYYY-MM-DD.
 *
 * The formatter — not the host's local clock — decides the day, so a server in
 * UTC and a browser anywhere agree on where midnight falls. `en-CA` is the
 * locale that prints an ISO-shaped date. An unusable zone falls back to the
 * product's default rather than throwing a balance out of existence.
 */
export function dewDay(at: number = Date.now(), timeZone: string = DEW_RESET_TIME_ZONE): string {
  const zone = isSupportedTimeZone(timeZone) ? timeZone : DEW_RESET_TIME_ZONE;
  return dayFormatter(zone).format(new Date(at));
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
 * The ledger a balance is derived from.
 *
 * `spent` is paid credit already used. `dailySpent` is free Dew already used on
 * `dailyDay`, tracked apart from `spent` so the daily bucket can roll over
 * without touching what somebody bought.
 */
export interface DewLedger {
  credits?: Record<string, number>;
  spent?: number;
  /** The day `dailySpent` belongs to, YYYY-MM-DD. */
  dailyDay?: string | null;
  /** Free Dew used on `dailyDay`; never part of `spent`. */
  dailySpent?: number;
}

/**
 * One account's paid Dew: credits minus spend, floored at zero.
 *
 * The stored shape is a map of credits and a spent total:
 *   { credits: { TRIAL: 5, CODE1: 100 }, spent: 12.375 }
 * The balance is always derived — credits minus spent — never read from a
 * single scalar a client could have written. Free daily Dew is deliberately
 * not folded in here: what somebody bought must not expire at midnight. Use
 * `dewAvailableFrom` for the number that can be spent right now.
 */
export function dewBalanceFrom(raw: DewLedger | null | undefined): number {
  if (!raw || typeof raw !== "object") return 0;
  const credits = sumCredits((raw as Record<string, unknown>).credits as Record<string, number>);
  const spent = (raw as Record<string, unknown>).spent;
  const spentValue = typeof spent === "number" && Number.isFinite(spent) && spent > 0 ? toMillidew(spent) : 0;
  return roundDew(Math.max(0, (credits - spentValue) / 1000));
}

/**
 * Free Dew still available on `today`.
 *
 * A bucket from an earlier day is not carried over: its leftover is gone and
 * the new day starts full. A used-up bucket reports zero rather than a
 * negative.
 *
 * Only a *later* day refills the bucket. A stored day ahead of `today` means
 * the clock has moved backwards — the account changed zone, or somebody edited
 * the column directly — and handing out another allotment would let that be
 * done over and over. The bucket simply stays where it was until the real day
 * catches up; `deduct_dew()` applies the same rule.
 */
export function dailyDewRemaining(
  raw: DewLedger | null | undefined,
  today: string = dewDay(),
  allowance: number = DAILY_FREE_DEW
): number {
  const day = typeof raw?.dailyDay === "string" ? raw.dailyDay.slice(0, 10) : "";
  if (!day || day < today) return allowance;
  const used = raw?.dailySpent;
  const spent = typeof used === "number" && Number.isFinite(used) && used > 0 ? used : 0;
  return roundDew(Math.max(0, allowance - spent));
}

/**
 * What this ledger can spend right now: paid Dew plus today's free allotment.
 *
 * This is the number the balance chip shows and the number a route pre-flights
 * against. The charge itself spends the free bucket first (see `deduct_dew()`),
 * so the two always agree.
 */
export function dewAvailableFrom(
  raw: DewLedger | null | undefined,
  today: string = dewDay(),
  allowance: number = DAILY_FREE_DEW
): number {
  return roundDew(dewBalanceFrom(raw) + dailyDewRemaining(raw, today, allowance));
}

/** The bucket size a given account gets: the paid pass raises it to 15. */
export function dailyAllowance(paid: boolean): number {
  return paid ? PAID_DAILY_FREE_DEW : DAILY_FREE_DEW;
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
  return `**You need an hour to keep chatting.** Openmi charges for time, not per message: ${formatDew(DEW_PER_HOUR)} Dew covers every answer in every chat for one hour. You get ${formatDew(DAILY_FREE_DEW)} free Dew every day (${formatDew(PAID_DAILY_FREE_DEW)} with a paid pass), refilled at midnight in your account's timezone, so those free Dew already buy ${formatDew(DAILY_FREE_DEW / DEW_PER_HOUR)} hours a day. Start an hour from the composer, top up on the /plus page, or redeem a Dew code.`;
}
