// ── Where the Dew went ───────────────────────────────────────────────────────
//
// A balance is an answer to "how much is left". It is not an answer to "why is
// it going down", which is the question a pay-as-you-go product has to answer
// before people trust it with a top-up. This module turns the rows the ledger
// already keeps into that second answer: spend per day, free versus paid, which
// model the requests ran on, and what was added.
//
// Pure by design. The route reads the rows with the caller's token; this file
// decides what they mean, so the page and the tests cannot drift apart. Days are
// grouped in the account's own timezone — the same midnight that refills the
// free bucket — not the browser's, so a day here matches a day on the Dew page.
//
// Rows written before the split existed carry no `free` amount; their whole
// price is treated as paid. That is the honest reading: the free bucket was not
// tracked then, and inventing a split would be worse than admitting it.

import { dewDay, roundDew } from "./dew";

export interface ActivityCharge {
  /** Epoch milliseconds. */
  at: number;
  /** The full price of the request. */
  dew: number;
  /** `auto`, `code`, or whatever else the ledger recorded. */
  model: string | null;
  /** The part paid from the daily free bucket; the rest is paid credit. */
  free: number;
}

export interface ActivityCredit {
  at: number;
  code: string;
  amount: number;
}

export interface DewActivityDay {
  /** YYYY-MM-DD in the account's timezone. */
  day: string;
  spend: number;
  free: number;
  paid: number;
  requests: number;
}

export interface DewActivityModel {
  model: string;
  requests: number;
  spend: number;
}

export interface DewActivityTotals {
  spend: number;
  free: number;
  paid: number;
  requests: number;
  /** Spend in the current calendar month, in the account's timezone. */
  thisMonth: number;
  /** The month `thisMonth` describes, YYYY-MM. */
  month: string;
}

export interface DewActivity {
  windowDays: number;
  totals: DewActivityTotals;
  /** Every day in the window, oldest first, including quiet days. */
  days: DewActivityDay[];
  models: DewActivityModel[];
  /** Credits added in the window, newest first. */
  credits: ActivityCredit[];
  creditTotal: number;
}

export interface ActivityOptions {
  now: number;
  timeZone: string;
  windowDays?: number;
}

const DAY_MS = 86_400_000;

/** Millidew accumulator, so a month of tiny charges does not drift. */
function milli(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) : 0;
}

/**
 * The last `windowDays` day keys, oldest first.
 *
 * Steps are a fixed 24 hours and the keys are collected in a set: around a
 * daylight-saving change a step can land on the same date twice, and the set is
 * what keeps a quiet day from being listed twice or its spend counted twice.
 * The rare cost is a window one key short, never a duplicated one.
 */
function windowDays(now: number, timeZone: string, count: number): string[] {
  const keys = new Set<string>();
  for (let offset = 0; offset < count; offset += 1) {
    const noon = now - offset * DAY_MS;
    keys.add(dewDay(noon, timeZone));
  }
  return [...keys].sort();
}

/**
 * Aggregates charges and credits into the activity report.
 *
 * Credits are filtered to the window here as well as in the route, so a caller
 * holding older rows cannot inflate "added this month". Charges outside the
 * window are ignored, not counted in a hidden total.
 */
export function summarizeDewActivity(
  charges: ActivityCharge[],
  credits: ActivityCredit[],
  options: ActivityOptions
): DewActivity {
  const requested = options.windowDays ?? 30;
  const count = Math.min(90, Math.max(1, Math.round(requested)));
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const days = windowDays(now, options.timeZone, count);
  const inWindow = new Set(days);
  const today = dewDay(now, options.timeZone);
  const month = today.slice(0, 7);

  const emptyDay = (day: string): DewActivityDay => ({
    day,
    spend: 0,
    free: 0,
    paid: 0,
    requests: 0,
  });

  const byDay = new Map<string, DewActivityDay>(days.map((day) => [day, emptyDay(day)]));
  const byModel = new Map<string, { requests: number; milli: number }>();
  let spend = 0;
  let free = 0;
  let paid = 0;
  let requests = 0;
  let thisMonth = 0;

  for (const charge of charges) {
    if (!Number.isFinite(charge.at) || charge.at <= 0) continue;
    const price = roundDew(Math.max(0, Number(charge.dew) || 0));
    if (price <= 0) continue;
    const day = dewDay(charge.at, options.timeZone);
    if (!inWindow.has(day)) continue;

    const freePart = roundDew(Math.min(Math.max(0, Number(charge.free) || 0), price));
    const paidPart = roundDew(price - freePart);
    const row = byDay.get(day) ?? emptyDay(day);
    row.spend = roundDew(row.spend + price);
    row.free = roundDew(row.free + freePart);
    row.paid = roundDew(row.paid + paidPart);
    row.requests += 1;
    byDay.set(day, row);

    spend += milli(price);
    free += milli(freePart);
    paid += milli(paidPart);
    requests += 1;
    if (day.startsWith(month)) thisMonth += milli(price);

    const key = charge.model && charge.model.trim() ? charge.model.trim() : "unknown";
    const model = byModel.get(key) ?? { requests: 0, milli: 0 };
    model.requests += 1;
    model.milli += milli(price);
    byModel.set(key, model);
  }

  const creditRows = credits
    .filter((credit) => Number.isFinite(credit.at) && credit.at > 0)
    .filter((credit) => credit.at >= now - count * DAY_MS && credit.at <= now + DAY_MS)
    .filter((credit) => credit.amount > 0 && credit.code.length > 0)
    .sort((a, b) => b.at - a.at);

  return {
    windowDays: count,
    totals: {
      spend: roundDew(spend / 1000),
      free: roundDew(free / 1000),
      paid: roundDew(paid / 1000),
      requests,
      thisMonth: roundDew(thisMonth / 1000),
      month,
    },
    days: days.map((day) => byDay.get(day) ?? emptyDay(day)),
    models: [...byModel.entries()]
      .map(([model, value]) => ({
        model,
        requests: value.requests,
        spend: roundDew(value.milli / 1000),
      }))
      .sort((a, b) => b.spend - a.spend || a.model.localeCompare(b.model)),
    credits: creditRows,
    creditTotal: roundDew(creditRows.reduce((sum, credit) => sum + milli(credit.amount), 0) / 1000),
  };
}
