// ── A buyer's own receipts ──────────────────────────────────────────────────
// The other half of the receipt form: once a confirmation has been sent, the
// person who paid needs to see that it arrived and what the owner decided.
// Without this, "sent" is the last word the buyer ever gets, and the only way to
// learn whether it worked is to ask.
//
// The read runs as the buyer with their own session. Row-level security answers
// with their rows only — this module has no filter of its own to get wrong — and
// the file itself is not fetched here: the status is what the page needs, and a
// private screenshot does not need to be rendered a second time.

import { getSupabase } from "./supabase";
import type { ReceiptStatus } from "./receipts";

export interface BuyerReceipt {
  id: string;
  plan: string;
  planLabel: string;
  amount: number;
  status: ReceiptStatus;
  createdAt: number;
  /** When the owner answered, or null while it is still pending. */
  decidedAt: number | null;
  fileName: string;
}

function epoch(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * This browser's receipts, newest first.
 *
 * A failed read is an empty list rather than an error: the form above it still
 * works, and a status panel that refuses to load must not look like a payment
 * that was never received.
 */
export async function listMyReceipts(): Promise<BuyerReceipt[]> {
  const client = getSupabase();
  if (!client) return [];
  try {
    const { data, error } = await client
      .from("payment_receipts")
      .select("id, plan, plan_label, amount, status, created_at, decided_at, file_name")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return [];
    return ((data ?? []) as Record<string, unknown>[])
      .map((row) => ({
        id: String(row.id ?? ""),
        plan: typeof row.plan === "string" ? row.plan : "other",
        planLabel: typeof row.plan_label === "string" ? row.plan_label : "",
        amount: Number(row.amount) || 0,
        status:
          row.status === "approved"
            ? ("approved" as const)
            : row.status === "rejected"
              ? ("rejected" as const)
              : ("pending" as const),
        createdAt: epoch(row.created_at),
        decidedAt: row.decided_at ? epoch(row.decided_at) : null,
        fileName: typeof row.file_name === "string" ? row.file_name : "",
      }))
      .filter((row) => row.id.length > 0);
  } catch {
    return [];
  }
}
