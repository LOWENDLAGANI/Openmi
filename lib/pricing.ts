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
// This table is deliberately approximate and deliberately static: a price
// shown to a reader is informational until a transfer is taken, and the
// ringgit figure beside it is the one that is charged. MYR is hand-set at 4.4
// so the displayed price equals that transfer. Rows added for coverage came
// from open.er-api.com on 2026-10-29 (market mid-rates); the page labels every
// converted figure approximate, and a currency with no row is shown in USD.
const RATES: Record<string, number> = {
  AED: 3.67,
  ALL: 81.6039,
  AMD: 360,
  ARS: 1_538,
  AUD: 1.5,
  AZN: 1.6991,
  BAM: 1.7548,
  BDT: 120,
  BGN: 1.7548,
  BHD: 0.376,
  BND: 1.2818,
  BOB: 11.997,
  BRL: 5.5,
  BWP: 14.0511,
  CAD: 1.4,
  CHF: 0.88,
  CLP: 985,
  CNY: 7.2,
  COP: 3_147,
  CRC: 455,
  CZK: 23,
  DKK: 6.9,
  DOP: 60.8213,
  DZD: 135,
  EGP: 48,
  EUR: 0.92,
  FJD: 2.2446,
  GBP: 0.78,
  GEL: 2.5939,
  GHS: 11.6399,
  GTQ: 7.6378,
  HKD: 7.8,
  HUF: 329,
  IDR: 16_000,
  ILS: 3.7,
  INR: 88,
  IQD: 1_516,
  ISK: 122,
  JMD: 159,
  JOD: 0.709,
  JPY: 150,
  KES: 129,
  KHR: 4_072,
  KRW: 1_380,
  KWD: 0.31021,
  KZT: 456,
  LAK: 22_408,
  LBP: 89_500,
  LKR: 300,
  MAD: 9.8469,
  MDL: 18.0033,
  MKD: 55.3048,
  MMK: 2_098,
  MNT: 3_612,
  MOP: 8.0806,
  MUR: 47.5308,
  MXN: 18,
  MYR: 4.4,
  NGN: 1_600,
  NOK: 10.7,
  NPR: 140,
  NZD: 1.65,
  OMR: 0.3845,
  PEN: 3.4504,
  PGK: 4.477,
  PHP: 58,
  PKR: 278,
  PLN: 4,
  PYG: 5_809,
  QAR: 3.64,
  RON: 4.807,
  RSD: 106,
  SAR: 3.75,
  SEK: 10.5,
  SGD: 1.3,
  THB: 34,
  TND: 3.0131,
  TRY: 40,
  TTD: 6.7655,
  TWD: 32,
  TZS: 2_637,
  UAH: 45.607,
  UGX: 4_244,
  USD: 1,
  UYU: 40.1803,
  UZS: 11_984,
  VND: 26_000,
  XAF: 589,
  XOF: 589,
  ZAR: 18,
  ZMW: 20.1736,
};


const REGION_CURRENCY: Record<string, string> = {
  AD: "EUR",
  AE: "AED",
  AL: "ALL",
  AM: "AMD",
  AR: "ARS",
  AU: "AUD",
  AZ: "AZN",
  BA: "BAM",
  BD: "BDT",
  BG: "BGN",
  BH: "BHD",
  BN: "BND",
  BO: "BOB",
  BR: "BRL",
  BW: "BWP",
  CA: "CAD",
  CH: "CHF",
  CI: "XOF",
  CL: "CLP",
  CM: "XAF",
  CN: "CNY",
  CO: "COP",
  CR: "CRC",
  CZ: "CZK",
  DK: "DKK",
  DO: "DOP",
  DZ: "DZD",
  EC: "USD",
  EG: "EGP",
  FJ: "FJD",
  GB: "GBP",
  GE: "GEL",
  GF: "EUR",
  GH: "GHS",
  GP: "EUR",
  GT: "GTQ",
  HK: "HKD",
  HU: "HUF",
  ID: "IDR",
  IL: "ILS",
  IN: "INR",
  IQ: "IQD",
  IS: "ISK",
  JM: "JMD",
  JO: "JOD",
  JP: "JPY",
  KE: "KES",
  KH: "KHR",
  KR: "KRW",
  KW: "KWD",
  KZ: "KZT",
  LA: "LAK",
  LB: "LBP",
  LK: "LKR",
  MA: "MAD",
  MC: "EUR",
  MD: "MDL",
  ME: "EUR",
  MK: "MKD",
  MM: "MMK",
  MN: "MNT",
  MO: "MOP",
  MQ: "EUR",
  MU: "MUR",
  MX: "MXN",
  MY: "MYR",
  NG: "NGN",
  NO: "NOK",
  NP: "NPR",
  NZ: "NZD",
  OM: "OMR",
  PA: "USD",
  PE: "PEN",
  PG: "PGK",
  PH: "PHP",
  PK: "PKR",
  PL: "PLN",
  PY: "PYG",
  QA: "QAR",
  RE: "EUR",
  RO: "RON",
  RS: "RSD",
  SA: "SAR",
  SE: "SEK",
  SG: "SGD",
  SM: "EUR",
  SN: "XOF",
  SV: "USD",
  TH: "THB",
  TL: "USD",
  TN: "TND",
  TR: "TRY",
  TT: "TTD",
  TW: "TWD",
  TZ: "TZS",
  UA: "UAH",
  UG: "UGX",
  US: "USD",
  UY: "UYU",
  UZ: "UZS",
  VN: "VND",
  XK: "EUR",
  YT: "EUR",
  ZA: "ZAR",
  ZM: "ZMW",
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
  // Three significant digits once a unit is worth a fraction of a cent, whole
  // units while it is worth more than that, and cents below a dollar. Keying
  // this on the currency rather than on one rate threshold is what keeps ￥600
  // and ￥1,200 from collapsing into ￥1,000, and it needs no table that a newly
  // added currency could be missing from.
  const amount =
    rate < 1
      ? Math.round(converted * 100) / 100
      : rate < 100
        ? Math.round(converted)
        : Number(converted.toPrecision(3));
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
