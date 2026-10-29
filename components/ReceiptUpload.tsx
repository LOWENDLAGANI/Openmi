"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Spinner from "./Spinner";
import { PAYMENT_HOST, PAYMENT_LINK_LABEL, PAYMENT_URL } from "@/lib/dew";
import { PAID_PLANS } from "@/lib/pricing";
import {
  RECEIPT_BUCKET,
  RECEIPT_MAX_BYTES,
  RECEIPT_STATUS_LABELS,
  receiptDaysLeft,
  receiptExtension,
  validateReceiptFile,
} from "@/lib/receipts";
import { listMyReceipts, type BuyerReceipt } from "@/lib/myReceipts";
import { currentUser, getSupabase, supabaseConfigured } from "@/lib/supabase";

// ── Send a receipt ───────────────────────────────────────────────────────────
// The buyer's half of a manual sale. Payment happens on the project's payment
// page, and this form is how the owner learns whose account the transfer belongs
// to — a bank feed cannot tell them that.
//
// Three decisions worth naming:
//
//   * The name is asked for even though the account has one. A transfer is made
//     under a bank account holder's name, and that is what the owner sees on
//     their side; "the person's Openmi display name" only helps when the two
//     match, so both are on the row.
//   * The file goes to a private bucket under the buyer's own uid, never to a
//     public path. The row keeps the path, and the console reads it through a
//     short-lived signed URL.
//   * Nothing here activates anything. Both sentences say so, because a screen
//     that says "sent" with no balance movement reads as a failure otherwise.

const PLAN_OPTIONS = [
  ...PAID_PLANS.map((plan) => ({ id: plan.id, label: `${plan.label} — RM ${plan.ringgit}`, ringgit: plan.ringgit })),
  { id: "other", label: "Another amount", ringgit: 0 },
];

export default function ReceiptUpload({ defaultName = null }: { defaultName?: string | null }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(defaultName ?? "");
  const [planId, setPlanId] = useState<string>(PAID_PLANS[PAID_PLANS.length - 1]?.id ?? "30d");
  const [amount, setAmount] = useState<string>(String(PAID_PLANS[PAID_PLANS.length - 1]?.ringgit ?? ""));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // The buyer's own receipts, so a sent confirmation is followed rather than
  // forgotten. Null while the first read is in flight.
  const [mine, setMine] = useState<BuyerReceipt[] | null>(null);

  const plan = useMemo(() => PLAN_OPTIONS.find((option) => option.id === planId) ?? PLAN_OPTIONS[0], [planId]);

  /** Re-reads the status list after a send, so the new row appears at once. */
  const loadMine = () => {
    void listMyReceipts()
      .then(setMine)
      .catch(() => setMine([]));
  };

  useEffect(() => {
    let cancelled = false;
    void listMyReceipts()
      .then((rows) => {
        if (!cancelled) setMine(rows);
      })
      .catch(() => {
        if (!cancelled) setMine([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickPlan = (id: string) => {
    setPlanId(id);
    const chosen = PLAN_OPTIONS.find((option) => option.id === id);
    if (chosen && chosen.ringgit > 0) setAmount(String(chosen.ringgit));
    else setAmount("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setSent(null);

    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      setError("Add the name the payment was made under, so it can be matched.");
      return;
    }
    const paid = Number(amount);
    if (!Number.isFinite(paid) || paid <= 0 || paid > 100000) {
      setError("Enter the amount you paid, in ringgit.");
      return;
    }
    if (!file) {
      setError("Choose the screenshot or PDF of the payment.");
      return;
    }
    const fileProblem = validateReceiptFile(file);
    if (fileProblem) {
      setError(fileProblem);
      return;
    }
    if (!supabaseConfigured) {
      setError("This deployment cannot store a receipt yet — no account service is configured.");
      return;
    }

    setBusy(true);
    let uploadedPath: string | null = null;
    try {
      const client = getSupabase();
      const user = await currentUser();
      if (!client || !user) {
        setError("Sign in again before sending a receipt.");
        return;
      }

      const extension = receiptExtension(file.name, file.type);
      const path = `${user.id}/${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${extension}`;
      const upload = await client.storage.from(RECEIPT_BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });
      if (upload.error) {
        setError(
          `The file could not be uploaded (${upload.error.message}). Try a smaller screenshot, or send it again.`
        );
        return;
      }
      uploadedPath = path;

      const { error: insertError } = await client.from("payment_receipts").insert({
        owner: user.id,
        name: trimmedName,
        plan: plan.id,
        plan_label: plan.id === "other" ? note.trim().slice(0, 40) || "Another amount" : plan.label,
        amount: paid,
        reference: reference.trim().slice(0, 120),
        note: note.trim().slice(0, 500),
        storage_path: path,
        file_name: file.name.slice(0, 200),
        mime_type: file.type,
      });
      if (insertError) {
        // The file without its row is an orphan nobody can find; remove it
        // rather than leaving a stray upload in the bucket.
        await client.storage.from(RECEIPT_BUCKET).remove([path]).catch(() => undefined);
        uploadedPath = null;
        setError(`The receipt could not be recorded (${insertError.message}). Try again.`);
        return;
      }

      setSent(
        `Receipt sent for ${trimmedName}. It shows as pending below until the owner reviews it — the pass is not active yet.`
      );
      loadMine();
      setName(trimmedName);
      setReference("");
      setNote("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (cause) {
      if (uploadedPath) {
        const client = getSupabase();
        await client?.storage.from(RECEIPT_BUCKET).remove([uploadedPath]).catch(() => undefined);
      }
      setError(cause instanceof Error ? cause.message : "The receipt could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="send-receipt"
      className="mt-5 scroll-mt-6 rounded-[22px] border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold text-white">Send your receipt</h2>
        <a
          href={PAYMENT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[11.5px] font-medium text-[#a9d8bb] transition-colors hover:text-[#c9e6d4]"
        >
          {PAYMENT_LINK_LABEL} ↗
        </a>
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-white/45">
        Paid on {PAYMENT_HOST}? Send the confirmation here and the owner activates your pass. The
        screenshot is private to you and the owner, and it is wiped thirty days after it is marked
        saved.
      </p>

      <form onSubmit={submit} className="mt-3 space-y-2.5">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
              Name on the payment
            </span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Aisyah Rahman"
              maxLength={80}
              autoComplete="name"
              className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-[#2f6b48]/60"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
              Pass paid for
            </span>
            <select
              value={planId}
              onChange={(event) => pickPlan(event.target.value)}
              className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2.5 text-[13px] text-white outline-none focus:border-[#2f6b48]/60"
            >
              {PLAN_OPTIONS.map((option) => (
                <option key={option.id} value={option.id} className="bg-[#111a16]">
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
              Amount paid (RM)
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="35.00"
              className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-[#2f6b48]/60"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
              Reference (optional)
            </span>
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Transaction id"
              maxLength={120}
              spellCheck={false}
              className="w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-[#2f6b48]/60"
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
            Receipt file
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,application/pdf"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
            }}
            className="w-full cursor-pointer rounded-xl border border-dashed border-white/[0.14] bg-black/20 px-3 py-2.5 text-[12px] text-white/60 file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-white/[0.10] file:px-2.5 file:py-1.5 file:text-[11.5px] file:font-medium file:text-white/80"
          />
          <span className="mt-1 block text-[10.5px] text-white/30">
            PNG, JPEG, WebP or PDF · up to {Math.round(RECEIPT_MAX_BYTES / (1024 * 1024))} MB.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
            Note (optional)
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 500))}
            rows={2}
            placeholder="Anything the owner should know"
            className="w-full resize-none rounded-xl border border-white/[0.09] bg-black/25 px-3 py-2.5 text-[13px] leading-relaxed text-white outline-none placeholder:text-white/25 focus:border-[#2f6b48]/60"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-xl border border-red-400/20 bg-red-500/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-red-200/90">
            {error}
          </p>
        )}
        {sent && (
          <p role="status" className="rounded-xl border border-[#2f6b48]/30 bg-[#2f6b48]/10 px-3 py-2 text-[11.5px] leading-relaxed text-[#a9d8bb]">
            {sent}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-[#2f6b48] py-3 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#3a8359] disabled:opacity-50"
        >
          {busy && <Spinner size={14} className="text-white" />}
          {busy ? "Sending…" : "Send receipt"}
        </button>
      </form>

      {/* ── What happened to it ───────────────────────────────────────────
          A receipt that is sent and then invisible reads as lost. This list is
          the buyer's side of the owner's decision: pending, saved, and when a
          saved file is due to be wiped. */}
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">
          Your receipts
        </h3>
        {mine === null ? (
          <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-white/35">
            <Spinner size={12} className="text-[#a9d8bb]" />
            Reading your receipts…
          </p>
        ) : mine.length === 0 ? (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/35">
            Nothing sent yet. After you pay, send the confirmation above and it appears here.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {mine.map((receipt) => {
              const status = receipt.status;
              const decided = status !== "pending";
              const left = receiptDaysLeft(receipt.decidedAt);
              return (
                <li
                  key={receipt.id}
                  className="flex items-start gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium text-white/80">
                      {receipt.planLabel || receipt.plan} · RM {receipt.amount.toFixed(2)}
                    </p>
                    <p className="mt-0.5 text-[10px] text-white/30">
                      Sent {receipt.createdAt ? new Date(receipt.createdAt).toLocaleDateString() : "—"}
                      {decided && left !== null
                        ? left > 0
                          ? ` · file wipes in ${left} day${left === 1 ? "" : "s"}`
                          : " · file wiped"
                        : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide ${
                      status === "approved"
                        ? "bg-[#a9d8bb]/15 text-[#a9d8bb]"
                        : status === "rejected"
                          ? "bg-red-400/15 text-red-200/90"
                          : "bg-amber-400/15 text-amber-100/90"
                    }`}
                  >
                    {RECEIPT_STATUS_LABELS[status]}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-1.5 text-[10px] leading-relaxed text-white/25">
          Only you and the owner can see a receipt. Approving or rejecting it is shown here, and the
          file is wiped thirty days after that decision.
        </p>
      </div>
    </section>
  );
}
