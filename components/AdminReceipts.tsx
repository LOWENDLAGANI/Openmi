"use client";

import { useCallback, useEffect, useState } from "react";
import Spinner from "./Spinner";
import {
  appendAdminAudit,
  decidePaymentReceipt,
  deletePaymentReceipt,
  grantPlan,
  listPaymentReceipts,
} from "@/lib/cloudAdmin";
import {
  RECEIPT_RETENTION_DAYS,
  RECEIPT_STATUS_LABELS,
  receiptDaysLeft,
  type PaymentReceipt,
} from "@/lib/receipts";
import { PAID_PLANS } from "@/lib/pricing";

// ── Receipts waiting on the owner ────────────────────────────────────────────
// A buyer sends proof of a transfer from the top-up page, and this is the other
// end of it: the name the payment was made under, the pass it was for, the
// amount, and the file itself through a short-lived signed link.
//
// There are two answers, not one: approve the payment, or reject it. Both are a
// decision, both record who made it and when, and both are visible to the buyer
// on the top-up page — a refusal the buyer cannot see is a payment they will
// keep asking about. Either answer starts the thirty-day wipe clock. The sweep
// runs when this list is read, so the promise holds without a scheduler.
//
// Activating the pass is the other half, and it happens on the same row: the
// receipt already names the pass and the buyer, so making the owner copy a uid
// into another form was the step where a payment got lost. Activation grants the
// days, then approves the receipt — one decision, one click, one wipe clock.
//
// "Wipe" is for the other case: a receipt that should never have been kept —
// wrong person, wrong file, a payment that was never made. It deletes the file
// before the row, so no orphan is left in the bucket.

function when(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export default function AdminReceipts({ onError }: { onError?: (message: string) => void }) {
  const [receipts, setReceipts] = useState<PaymentReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReceipts(await listPaymentReceipts());
    } catch (cause) {
      console.error("[openmi] Failed to list receipts", cause);
      const message = cause instanceof Error ? cause.message : "Could not read the receipts.";
      setError(message);
      onError?.(message);
      setReceipts([]);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Records the answer, either way.
   *
   * The list is re-read after the write instead of patched in place: the sweep
   * may have removed other rows in the same pass, and a stale list is how a
   * wiped receipt reappears after a refresh. A rejection is its own ledger
   * word, so the log can still answer "who refused this payment".
   */
  const decide = async (receipt: PaymentReceipt, status: "approved" | "rejected") => {
    if (busy) return;
    setBusy(`decision:${receipt.id}`);
    setError(null);
    setNotice(null);
    try {
      await decidePaymentReceipt(receipt.id, status);
      await appendAdminAudit({
        at: Date.now(),
        action: status === "approved" ? "saveReceipt" : "rejectReceipt",
        uid: receipt.owner,
        note: receipt.name,
      }).catch(() => undefined);
      await load();
      setNotice(
        status === "approved"
          ? `${receipt.name} approved. The receipt is wiped in ${RECEIPT_RETENTION_DAYS} days.`
          : `${receipt.name} rejected. The buyer sees it as rejected, and the file is wiped in ${RECEIPT_RETENTION_DAYS} days.`
      );
    } catch (cause) {
      console.error("[openmi] Failed to record the receipt decision", cause);
      const message =
        cause instanceof Error ? cause.message : "The receipt could not be updated.";
      setError(message);
      onError?.(message);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Turns a receipt into an active pass, then closes the receipt.
   *
   * The grant goes through `admin_grant_plan()` and the save through the same
   * update the Saved button uses, so this is exactly the two steps the owner
   * took by hand — only without copying a visitor id between two forms. A
   * refusal from either leaves the receipt untouched and says why.
   */
  const activate = async (receipt: PaymentReceipt, days: number) => {
    if (busy) return;
    setBusy(`pass:${receipt.id}`);
    setError(null);
    setNotice(null);
    try {
      const grant = await grantPlan(receipt.owner, days);
      await decidePaymentReceipt(receipt.id, "approved");
      // Best effort: a policy that refuses the ledger must not undo the pass.
      await appendAdminAudit({
        at: Date.now(),
        action: "grantPlan",
        uid: receipt.owner,
        note: `${days}-day pass from receipt ${receipt.id}`,
      }).catch(() => undefined);
      await appendAdminAudit({
        at: Date.now(),
        action: "saveReceipt",
        uid: receipt.owner,
        note: receipt.name,
      }).catch(() => undefined);
      await load();
      setNotice(
        `${receipt.name}: ${days}-day pass active until ${new Date(grant.until).toLocaleDateString()}. Receipt approved — wiped in ${RECEIPT_RETENTION_DAYS} days.`
      );
    } catch (cause) {
      console.error("[openmi] Failed to activate pass from receipt", cause);
      const message = cause instanceof Error ? cause.message : "The pass was not activated.";
      setError(message);
      onError?.(message);
    } finally {
      setBusy(null);
    }
  };

  const wipe = async (receipt: PaymentReceipt) => {
    if (busy) return;
    setBusy(`wipe:${receipt.id}`);
    setError(null);
    setNotice(null);
    try {
      await deletePaymentReceipt(receipt.id, receipt.storagePath);
      setReceipts((current) => (current ?? []).filter((item) => item.id !== receipt.id));
      if (openId === receipt.id) setOpenId(null);
      setNotice(`Receipt from ${receipt.name} wiped.`);
    } catch (cause) {
      console.error("[openmi] Failed to wipe receipt", cause);
      const message = cause instanceof Error ? cause.message : "The receipt could not be wiped.";
      setError(message);
      onError?.(message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[10px] leading-relaxed text-white/35">
        Proof of a payment sent from the top-up page. Approving or rejecting it answers the buyer on
        the top-up page; either answer starts the {RECEIPT_RETENTION_DAYS}-day wipe, and activating a pass
        approves the receipt as well.
      </p>

      {error && (
        <p role="alert" className="rounded-[12px] border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[11px] leading-relaxed text-red-200/90">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-[12px] border border-[#2f6b48]/30 bg-[#2f6b48]/10 px-3 py-2 text-[11px] leading-relaxed text-[#a9d8bb]">
          {notice}
        </p>
      )}

      {receipts === null ? (
        <p className="flex items-center gap-1.5 py-2 text-[11px] text-white/35">
          <Spinner size={12} className="text-[#a9d8bb]" />
          Reading receipts…
        </p>
      ) : receipts.length === 0 ? (
        <p className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-[11px] leading-relaxed text-white/40">
          No receipts waiting. A receipt appears here when a buyer sends one from the top-up page.
        </p>
      ) : (
        <ul className="space-y-2">
          {receipts.map((receipt) => {
            const status = receipt.status;
            const decided = status !== "pending";
            const left = receiptDaysLeft(receipt.decidedAt);
            const isImage = receipt.mimeType.startsWith("image/");
            const expanded = openId === receipt.id;
            const plan = PAID_PLANS.find((entry) => entry.id === receipt.plan);
            return (
              <li
                key={receipt.id}
                className={`rounded-[14px] border px-3 py-2.5 ${
                  status === "pending"
                    ? "border-[#a9d8bb]/25 bg-[#a9d8bb]/[0.05]"
                    : status === "rejected"
                      ? "border-red-400/20 bg-red-500/[0.04]"
                      : "border-white/[0.07] bg-white/[0.02]"
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-white/90">
                      <span className="truncate">{receipt.name}</span>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                          status === "approved"
                            ? "bg-[#a9d8bb]/20 text-[#a9d8bb]"
                            : status === "rejected"
                              ? "bg-red-400/15 text-red-200/90"
                              : "bg-amber-400/15 text-amber-100/90"
                        }`}
                      >
                        {RECEIPT_STATUS_LABELS[status]}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[10px] text-white/35">
                      {receipt.planLabel || receipt.plan} · RM {receipt.amount.toFixed(2)} ·{" "}
                      {when(receipt.createdAt)}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[9.5px] text-white/25">
                      {receipt.owner}
                    </p>
                    {receipt.reference && (
                      <p className="mt-0.5 truncate text-[10px] text-white/35">Ref: {receipt.reference}</p>
                    )}
                    {receipt.note && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-[10.5px] leading-relaxed text-white/50">
                        {receipt.note}
                      </p>
                    )}
                    {decided && (
                      <p className="mt-1 text-[10px] text-white/30">
                        {left === null
                          ? `Wipes ${RECEIPT_RETENTION_DAYS} days after the decision.`
                          : left > 0
                            ? `${RECEIPT_STATUS_LABELS[status]} ${when(receipt.decidedAt)} · wipes in ${left} day${left === 1 ? "" : "s"}.`
                            : "Due to be wiped."}
                      </p>
                    )}
                  </div>

                  {receipt.previewUrl ? (
                    isImage ? (
                      <button
                        type="button"
                        onClick={() => setOpenId(expanded ? null : receipt.id)}
                        aria-expanded={expanded}
                        className="shrink-0 overflow-hidden rounded-[10px] border border-white/[0.09]"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={receipt.previewUrl}
                          alt={`Receipt from ${receipt.name}`}
                          className={`h-14 w-14 object-cover transition-transform ${expanded ? "scale-105" : ""}`}
                        />
                      </button>
                    ) : (
                      <a
                        href={receipt.previewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 rounded-[10px] border border-white/[0.12] px-2 py-1.5 text-[10px] font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white"
                      >
                        PDF ↗
                      </a>
                    )
                  ) : (
                    <span className="shrink-0 text-[10px] text-white/25">No preview</span>
                  )}
                </div>

                {expanded && receipt.previewUrl && (
                  <a
                    href={receipt.previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 block overflow-hidden rounded-[12px] border border-white/[0.08] bg-black/30"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={receipt.previewUrl}
                      alt={`Receipt from ${receipt.name}, full size`}
                      className="max-h-[52vh] w-full object-contain"
                    />
                  </a>
                )}

                <div className="mt-2 flex items-center gap-1.5">
                  {plan ? (
                    <button
                      type="button"
                      onClick={() => void activate(receipt, plan.days)}
                      disabled={busy !== null}
                      className="flex-1 rounded-[9px] bg-white/[0.10] px-2.5 py-1.5 text-[10.5px] font-semibold text-white transition-colors hover:bg-white/[0.16] disabled:opacity-40"
                    >
                      {busy === `pass:${receipt.id}` ? "Activating…" : `Activate ${plan.days}-day pass`}
                    </button>
                  ) : (
                    <span className="flex flex-1 items-center gap-1">
                      <span className="text-[10px] text-white/35">Activate</span>
                      {PAID_PLANS.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => void activate(receipt, entry.days)}
                          disabled={busy !== null}
                          className="rounded-[8px] bg-white/[0.08] px-2 py-1 text-[10px] font-semibold text-white/80 transition-colors hover:bg-white/[0.14] disabled:opacity-40"
                        >
                          {entry.days}d
                        </button>
                      ))}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void decide(receipt, "approved")}
                    disabled={status === "approved" || busy !== null}
                    className="rounded-[9px] bg-[#2f6b48]/30 px-2.5 py-1.5 text-[10.5px] font-semibold text-[#d7f0e1] transition-colors hover:bg-[#2f6b48]/45 disabled:opacity-40"
                  >
                    {busy === `decision:${receipt.id}` ? "Saving…" : "Approve"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void decide(receipt, "rejected")}
                    disabled={status === "rejected" || busy !== null}
                    className="rounded-[9px] px-2.5 py-1.5 text-[10.5px] font-semibold text-red-200/75 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:opacity-40"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => void wipe(receipt)}
                    disabled={busy !== null}
                    className="rounded-[9px] px-2.5 py-1.5 text-[10.5px] text-white/35 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                  >
                    {busy === `wipe:${receipt.id}` ? "Wiping…" : "Wipe"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
