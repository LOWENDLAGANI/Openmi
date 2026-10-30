"use client";

import { useEffect, useState } from "react";
import { PAYMENT_HOST, PAYMENT_LINK_LABEL, PAYMENT_URL, formatDew, type DewPack } from "@/lib/dew";

// ── Pay for Dew ──────────────────────────────────────────────────────────────
// The pay-as-you-go top-up dialog. The buyer picks a pack on /plus, and this
// sends them to the payment page with the exact ringgit amount written down.
//
// It used to hold a DuitNow QR. The QR carried no amount, so the number here was
// the whole instruction and a mistyped figure could not be caught by anybody.
// A link to the payment page is the one place the amount, the provider and the
// instructions are correct together, so this dialog's job is now to name the
// amount and to say what to do with the proof afterwards.
//
// The receipt is not optional: a transfer that lands with no screenshot attached
// to an account is a payment the owner has to match by hand from a bank feed.
// The last step therefore points at the receipt form, rather than ending the
// flow at "Done".

export default function DewPayDialog({
  pack,
  onClose,
  onSendReceipt,
}: {
  pack: DewPack;
  onClose: () => void;
  /** Moves the page to the receipt form; the dialog closes first. */
  onSendReceipt?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const payable = `RM ${pack.ringgit.toFixed(2)}`;

  async function copyAmount() {
    try {
      await navigator.clipboard.writeText(pack.ringgit.toFixed(2));
    } catch {
      // Clipboard can be blocked (insecure origin, denied permission); the
      // amount is on screen anyway, so failing quietly is fine.
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Top up ${formatDew(pack.dew)} Dew`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-sm sm:p-8"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="animate-pop relative my-auto w-full max-w-md rounded-[28px] border border-[#2f6b48]/25 bg-[#111a16] p-6 shadow-[0_0_60px_-20px_rgba(47,107,72,0.8)] sm:p-7"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="lift absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.07] text-white/70 transition-colors hover:bg-white/[0.14] hover:text-white"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
          </svg>
        </button>

        <h2 className="pr-10 text-[19px] font-semibold leading-tight tracking-tight">Top up Dew</h2>
        <p className="mt-1 text-[14px] leading-snug text-white/55">
          {formatDew(pack.dew)} Dew — 1 Dew ≈ US$0.01 of model use.
        </p>

        <div className="mt-5 flex items-baseline gap-2">
          <span className="text-[clamp(2.2rem,9vw,3rem)] font-semibold leading-none tracking-tight text-white">
            {payable}
          </span>
          <button
            onClick={copyAmount}
            aria-label={`Copy the amount ${payable}`}
            className="ml-auto shrink-0 rounded-full border border-white/[0.12] px-2.5 py-1 text-[11.5px] font-medium text-white/60 transition-colors hover:border-white/25 hover:text-white"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <a
          href={PAYMENT_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="lift mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-white py-3.5 text-[15px] font-semibold text-black transition-transform"
        >
          {PAYMENT_LINK_LABEL}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
          </svg>
        </a>
        <p className="mt-2 text-center text-[11.5px] leading-relaxed text-white/35">
          Opens {PAYMENT_HOST} in a new tab. Pay {payable} there, then come back here.
        </p>

        <ol className="mt-5 space-y-2.5 border-t border-white/[0.07] pt-4 text-left text-[13.5px] leading-snug text-white/60">
          <li className="flex gap-2.5">
            <span className="shrink-0 font-semibold text-[#2f6b48]">1</span>
            <span>
              Open the payment page and send <span className="font-medium text-white">{payable}</span>.
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="shrink-0 font-semibold text-[#2f6b48]">2</span>
            <span>Keep the confirmation screenshot or PDF the provider gives you.</span>
          </li>
          <li className="flex gap-2.5">
            <span className="shrink-0 font-semibold text-[#2f6b48]">3</span>
            <span>
              Send it with your name on the top-up page. Your Dew is credited once the owner checks it.
            </span>
          </li>
        </ol>

        <div className="mt-6 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-full border border-white/[0.12] py-3.5 text-[14px] font-medium text-white/65 transition-colors hover:border-white/25 hover:text-white"
          >
            Done
          </button>
          {onSendReceipt && (
            <button
              onClick={onSendReceipt}
              className="flex-1 rounded-full bg-[#2f6b48] py-3.5 text-[14px] font-semibold text-white transition-colors hover:bg-[#3a8359]"
            >
              Send receipt
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
