// ── Paid passes and the price a person actually reads ───────────────────────
// Client-safe: no key, no provider and no wire model id belongs here.
//
// Two decisions are made in this module:
//
//   1. What a paid pass is. A pass is a number of days, and its benefit is the
//      larger daily Dew bucket from lib/dew.ts plus the support and usage
//      promises shown beside it. The pass itself lives on `profiles` and is
//      activated by the owner after a manual payment, which is the same door
//      every other payment in Openmi already uses.
//
//   2. What it costs on screen. Prices are set in US dollars, because that is
//      the unit the product is planned in, and shown in the currency of the
//      browser's region. The conversion is an approximation with a small static
//      table — enough to make a price legible without pretending to be a
//      checkout rate. The ringgit price is the one a DuitNow transfer uses.

export type PlanId = "15d" | "30d";

export interface PaidPlan {
  id: PlanId;
  days: number;
  /** The planning price, in whole US dollars. */
  usd: number;
  /** What a DuitNow transfer asks for, in ringgit. */
  ringgit: number;
  label: string;
  /** The line that makes the shorter pass worth choosing. */
  note: string;
}

export const PAID_PLANS: readonly PaidPlan[] = [
  {
    id: "15d",
    days: 15,
    usd: 4,
    ringgit: 18,
    label: "15 days",
    note: "A fortnight at the paid bucket.",
  },
  {
    id: "30d",
    days: 30,
    usd: 8,
    ringgit: 35,
    label: "30 days",
    note: "The best value — two weeks free.",
  },
] as const;

/** Everything a paid pass promises, in the order the wallet lists it. */
export const PAID_BENEFITS: readonly string[] = [
  "Bumped up to 15 Dew",
  "Priority support",
  "More usage",
  "Everything in Free",
] as const;

export function paidPlan(id: string): PaidPlan | null {
  return PAID_PLANS.find((plan) => plan.id === id) ?? null;
}

// ── Local prices ────────────────────────────────────────────────────────────
// One rate per currency, deliberately approximate. A price shown to a reader is
// informational until a payment is actually taken, and the manual transfer is
// always quoted in ringgit.

const RATES: Record<string, number> = {
  USD: 1,
  MYR: 4.4,
  SGD: 1.3,
  IDR: 16_000,
  PHP: 58,
  THB: 34,
  VND: 26_000,
  INR: 88,
  GBP: 0.78,
  CAD: 1.4,
  AUD: 1.5,
  NZD: 1.65,
  JPY: 150,
  CNY: 7.2,
  HKD: 7.8,
  KRW: 1_380,
  TWD: 32,
  AED: 3.67,
  SAR: 3.75,
  BRL: 5.5,
  MXN: 18,
  ZAR: 18,
  TRY: 40,
  CHF: 0.88,
  SEK: 10.5,
  NOK: 10.7,
  DKK: 6.9,
  PLN: 4,
  CZK: 23,
  ILS: 3.7,
  EGP: 48,
  NGN: 1_600,
  KES: 129,
  PKR: 278,
  BDT: 120,
  LKR: 300,
  NPR: 140,
  EUR: 0.92,
};

/**
 * How coarsely a currency is rounded on a price card.
 *
 * The step belongs to the currency, not to its rate. Yen and won are worth
 * fractions of a dollar and are still counted in whole units a person
 * recognises, so they round to 100; rupiah and dong are worth almost nothing,
 * so they round to 1,000. A single "rate >= 100" rule for both made the two
 * plans print the same number in Japan — ￥600 and ￥1,200 both became ￥1,000 —
 * which is a price card nobody can trust.
 */
const ROUNDING_STEP: Record<string, number> = {
  IDR: 1_000,
  VND: 1_000,
  JPY: 100,
  KRW: 100,
};

const REGION_CURRENCY: Record<string, string> = {
  US: "USD",
  MY: "MYR",
  SG: "SGD",
  ID: "IDR",
  PH: "PHP",
  TH: "THB",
  VN: "VND",
  IN: "INR",
  GB: "GBP",
  CA: "CAD",
  AU: "AUD",
  NZ: "NZD",
  JP: "JPY",
  CN: "CNY",
  HK: "HKD",
  KR: "KRW",
  TW: "TWD",
  AE: "AED",
  SA: "SAR",
  BR: "BRL",
  MX: "MXN",
  ZA: "ZAR",
  TR: "TRY",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  PL: "PLN",
  CZ: "CZK",
  IL: "ILS",
  EG: "EGP",
  NG: "NGN",
  KE: "KES",
  PK: "PKR",
  BD: "BDT",
  LK: "LKR",
  NP: "NPR",
};

/** The eurozone countries, which share one currency but not one code. */
const EURO_REGIONS = new Set([
  "DE", "FR", "ES", "IT", "NL", "PT", "IE", "AT", "BE", "FI", "GR", "SK", "SI",
  "LT", "LV", "EE", "LU", "MT", "CY", "HR",
]);

/** The browser's locale, with a server-safe fallback. */
export function browserLocale(): string {
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en-US";
}

/** The currency of a locale's region, or USD when there is no better answer. */
export function currencyForLocale(locale: string = browserLocale()): string {
  let region = "";
  try {
    region = new Intl.Locale(locale).region ?? "";
  } catch {
    // An old engine, or a tag Intl cannot parse: the regex below still tries.
  }
  if (!region) {
    const match = locale.match(/[-_]([A-Za-z]{2})(?:[-_]|$)/);
    region = match?.[1]?.toUpperCase() ?? "";
  }
  if (EURO_REGIONS.has(region)) return "EUR";
  return REGION_CURRENCY[region] ?? "USD";
}

export interface LocalPrice {
  currency: string;
  amount: number;
  formatted: string;
  /** True when the figure was converted, so the UI can say "about". */
  approximate: boolean;
}

/**
 * Converts a US-dollar price into the reader's currency.
 *
 * Rounding is to a figure a person would put on a price card rather than to a
 * cent of a rate: whole units for most currencies, thousands for the ones whose
 * unit is worth very little, and cents only where one unit is worth more than a
 * dollar. The result is marked approximate whenever it is not the planning
 * currency, because it is.
 */
export function localPrice(usd: number, locale: string = browserLocale()): LocalPrice {
  // A region can be mapped before its rate exists, and showing eight dollars as
  // "8 KWD" is worse than showing it as dollars. The fallback is therefore the
  // currency itself, not a rate of 1.
  const requested = currencyForLocale(locale);
  const currency = RATES[requested] === undefined ? "USD" : requested;
  const rate = RATES[currency] ?? 1;
  const converted = usd * rate;
  const step = ROUNDING_STEP[currency] ?? (rate < 1 ? 0.01 : 1);
  const amount = Math.round(converted / step) * step;
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: rate < 1 ? 2 : 0,
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    formatted = `$${usd}`;
  }
  return { currency, amount, formatted, approximate: currency !== "USD" };
}

/** "about RM 18" / "$8" — the label a plan card prints. */
export function formatPlanPrice(usd: number, locale?: string): string {
  const price = localPrice(usd, locale);
  return price.approximate ? `about ${price.formatted}` : price.formatted;
}
