// Redeem codes — a word carrying Dew; the claim never carries an amount.

/**
 * How a code is written down.
 *
 * Upper case and no spaces, so `openmi-topup` and `OPENMI TOPUP` are one code rather
 * than two that a buyer could mistype between. The owner picks the word; this
 * only decides the form it is stored in.
 */
export const CODE_MAX = 32;

export function normalizeCode(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, CODE_MAX);
}

/** Whether a word can be used as a code at all. */
export function isValidCode(value: unknown): boolean {
  return normalizeCode(value).length >= 4;
}

/** One code, as stored. */
export interface RedeemCode {
  /** The word, normalized. */
  code: string;
  /** What redeeming it grants, in Dew. */
  dew: number;
  /**
   * Off means the code cannot be redeemed and grants nothing to anyone.
   *
   * A switch rather than a deletion, because an owner who has handed a word out
   * and then found it being resold needs to stop it *now* and be able to bring
   * it back without retyping it.
   */
  active: boolean;
  createdAt: number;
  note: string;
}

/**
 * Reads what the database holds.
 *
 * Returns null for anything malformed rather than a half-filled code: a record
 * with no Dew amount, a non-numeric one, a negative one, or one above the
 * ceiling the rules enforce. Legacy `plan`/`days` fields that may still sit on
 * an old record are ignored outright rather than honoured, so a plan value
 * cannot ride in on a code and become money.
 */
export function parseRedeemCode(raw: unknown): RedeemCode | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const code = normalizeCode(value.code ?? value.__name);
  if (!isValidCode(code)) return null;

  // A Dew amount is read strictly: a number, positive, and at most 100,000 —
  // the same ceiling the database validates on the write. A string
  // that happens to look like a number is refused rather than coerced: the rules
  // only ever store a number, so anything else arrived by some other road.
  const rawDew = value.dew;
  if (typeof rawDew !== "number" || !Number.isFinite(rawDew)) return null;
  if (rawDew <= 0 || rawDew > 100_000) return null;
  const dew = Math.round(rawDew * 1000) / 1000;

  const rawCreatedAt = value.createdAt;
  if (typeof rawCreatedAt !== "number" || !Number.isFinite(rawCreatedAt) || rawCreatedAt <= 0) return null;

  return {
    code,
    dew,
    // Absent `active` means created, which is what every code written by the
    // console carries. Defaulting the other way would silently kill every code
    // whose field went missing.
    active: value.active === undefined ? true : value.active === true,
    createdAt: rawCreatedAt,
    note: String(value.note ?? "").trim().slice(0, 120),
  };
}

/**
 * Reads a `redeem_codes` / `lookup_redeem_code()` row as a code record.
 *
 * PostgREST answers a `numeric` column as a string and a `timestamptz` as an
 * ISO date, so the mapping is done here once rather than in each of the three
 * places that read a code — the console, the claim box, and the server that
 * resolves a claim into Dew. All three then validate through the same parser,
 * which is what keeps them from disagreeing about what a code is worth.
 */
export function redeemCodeFromRow(raw: unknown): RedeemCode | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const createdAt =
    typeof row.created_at === "string" ? Date.parse(row.created_at) : row.createdAt;
  return parseRedeemCode({
    code: row.code,
    dew: row.dew === null || row.dew === undefined ? undefined : Number(row.dew),
    active: row.active,
    createdAt,
    note: row.note,
  });
}

// ── What a code is worth right now ───────────────────────────────────────────

export type RedeemStatus =
  | { ok: true; code: RedeemCode }
  | { ok: false; reason: "unknown" | "terminated"; message: string };

/**
 * Whether this code can be redeemed by somebody, at this moment.
 *
 * The owner can terminate a code at any time and this is where that takes
 * effect. There is no use count, and that is deliberate rather than an omission:
 * counting redemptions needs a write to `codes/`, which the rules reserve for
 * the administrator, and the deployment holds no service account to do it
 * another way. A counter that stayed at zero while the console printed "0/1
 * used" would be a control that looks real and does nothing, and a "used up"
 * refusal that could never be reached is worse than no such state at all.
 *
 * So one code is one word, and how many people use it is bounded by the owner's
 * switch rather than by a number: switch it off the moment a word is being
 * resold, which is the moment that matters.
 */
export function checkRedeemable(code: RedeemCode | null, now: number): RedeemStatus {
  if (!code) {
    return {
      ok: false,
      reason: "unknown",
      message: "That code was not recognised. Check the letters and try again.",
    };
  }
  if (!code.active) {
    return {
      ok: false,
      reason: "terminated",
      message: "That code has been switched off. Ask for a new one.",
    };
  }
  // Nothing is checked against `now` here: a code does not expire on its own. It
  // is worth what the owner said it is worth, for as long as they leave it on —
  // turning it off is how they end it, and guessing at a deadline of our own
  // would quietly invalidate a code somebody is mid-way through handing over.
  void now;
  return { ok: true, code };
}

// ── What a claim is worth ────────────────────────────────────────────────────

/** What redeeming a code produces: a top-up to the balance. */
export interface DewRedemption {
  code: string;
  dew: number;
}

/**
 * Turns a code into the top-up it grants.
 *
 * The amount comes from the code record, never from the claim — see the note at
 * the top of this file.
 */
export function dewRedemptionValue(code: RedeemCode): DewRedemption {
  return { code: code.code, dew: code.dew };
}
