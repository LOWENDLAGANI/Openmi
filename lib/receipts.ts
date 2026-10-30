// ── Receipts for a manual payment ───────────────────────────────────────────
// Pure rules only: no database, no fetch, no screen. The upload form, the admin
// console and the migration all read the same numbers from here, so the file a
// buyer is allowed to send is the file the bucket accepts, and the month the
// console promises is the month the sweep actually waits.
//
// A receipt is proof of a transfer the owner settles by hand. It is not a
// checkout: nothing is activated when it lands, and the console says so in both
// directions so nobody waits on a payment that already went through.

export const RECEIPT_BUCKET = "receipts";

/**
 * How long a saved receipt is kept.
 *
 * The owner marks a receipt saved once the pass is active. Thirty days is long
 * enough to answer a bank dispute and short enough that a folder of other
 * people's transfers does not accumulate; after it, the file and its row are
 * removed together.
 */
export const RECEIPT_RETENTION_DAYS = 30;
export const RECEIPT_RETENTION_MS = RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** The upload ceiling, matching `file_size_limit` on the bucket. */
export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * What a receipt may be.
 *
 * A screenshot in one of the formats a phone actually produces, or the bank's
 * PDF. SVG is deliberately absent: it is a document that can carry script, and
 * the console would be rendering it.
 */
export const RECEIPT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
] as const;

/**
 * What the owner has decided about a receipt.
 *
 * Three states, because a receipt can be three things: sent and not looked at
 * yet (`pending`), checked and confirmed (`approved`), checked and refused
 * (`rejected`). The first version of this table knew only two, so a refusal and
 * a receipt nobody had opened shared the word `new` — the buyer's list said
 * "pending review" about a payment that had already been answered.
 */
export type ReceiptStatus = "pending" | "approved" | "rejected";

/** The words a buyer and the owner both read for a state. */
export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = {
  pending: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
};

/** True once the owner has answered, either way. */
export function receiptDecided(status: ReceiptStatus): boolean {
  return status !== "pending";
}

/** One receipt as the console and its owner read it. */
export interface PaymentReceipt {
  id: string;
  owner: string;
  name: string;
  /** `15d`, `30d`, or `other` for a payment that names no pass. */
  plan: string;
  planLabel: string;
  amount: number;
  reference: string;
  note: string;
  storagePath: string;
  fileName: string;
  mimeType: string;
  status: ReceiptStatus;
  createdAt: number;
  /** When the owner approved or rejected it, or null while it is pending. */
  decidedAt: number | null;
  /** A short-lived URL from the private bucket, when one could be made. */
  previewUrl: string | null;
}

/** The extension a stored file gets, from its name or its type. */
export function receiptExtension(fileName: string, mimeType: string): string {
  const fromName = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

/** True when this is a file the bucket will accept. */
export function isReceiptMime(mimeType: string): boolean {
  return (RECEIPT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Why this file cannot be sent, or null when it can.
 *
 * Checked before the upload so a 5 MB phone photo is refused with a sentence
 * rather than after a minute of uploading. The bucket enforces the same rules
 * again; this is the courtesy, not the guard.
 */
export function validateReceiptFile(file: { name?: string; type?: string; size?: number }): string | null {
  const name = file.name ?? "";
  const type = file.type ?? "";
  const size = file.size ?? 0;
  if (!name) return "Choose a screenshot or PDF of the payment first.";
  if (!isReceiptMime(type)) {
    return "Send a PNG, JPEG, WebP screenshot or a PDF. Other file types are not accepted.";
  }
  if (size <= 0) return "That file is empty. Choose the receipt image again.";
  if (size > RECEIPT_MAX_BYTES) {
    return `That file is ${(size / (1024 * 1024)).toFixed(1)} MB. The limit is 5 MB — a screenshot is usually smaller.`;
  }
  return null;
}

/**
 * The moment a decided receipt is due to disappear.
 *
 * The clock starts on the decision, not on the upload: a receipt nobody has
 * answered is still the buyer's evidence that they paid, and deleting it would
 * erase the only record of a payment the owner has not looked at yet. An
 * approved and a rejected receipt both keep their proof for the same month, so
 * a disputed refusal can still be checked.
 */
export function receiptWipeAt(decidedAt: number | null): number | null {
  return decidedAt && Number.isFinite(decidedAt) ? decidedAt + RECEIPT_RETENTION_MS : null;
}

/** Whole days left before the wipe, floored at zero. */
export function receiptDaysLeft(decidedAt: number | null, now: number = Date.now()): number | null {
  const at = receiptWipeAt(decidedAt);
  if (at === null) return null;
  return Math.max(0, Math.ceil((at - now) / (24 * 60 * 60 * 1000)));
}

/** True when a decided receipt is past its retention and may be wiped. */
export function receiptExpired(decidedAt: number | null, now: number = Date.now()): boolean {
  const at = receiptWipeAt(decidedAt);
  return at !== null && at <= now;
}
