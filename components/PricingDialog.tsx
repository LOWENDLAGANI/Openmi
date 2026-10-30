"use client";

import { useEffect } from "react";
import Link from "next/link";
import { formatDew } from "@/lib/dew";
import Spinner from "@/components/Spinner";

// ── Pay for the hour ────────────────────────────────────────────────────────
//
// Openmi bills time, not messages: one price buys an hour of usage in every chat
// on one model — and, when it is bought in a repository, on that repository
// only. This dialog is the moment that hour is bought, so it says what the hour
// covers and where the Dew comes from — today's free bucket first, the wallet
// after it — because the charge itself already does exactly that.
//
// A live hour for a different model or repository is a refusal, not a silent
// replacement: the dialog says which hour is running and offers ending it as a
// separate, deliberate step. The server refuses until that happens.
//
// The price arrives as a prop from the server's price list. A modified client can
// change the number on screen, but not what `start_hour_session()` charges: the
// function carries its own constant and takes no price at all.

export interface PricingDialogProps {
  modeLabel: string;
  /** The repository the hour will be bound to, or null for ordinary chat. */
  repoLabel?: string | null;
  priceDew: number;
  /** Spendable now: today's free Dew plus the paid wallet. */
  balance: number;
  dailyRemaining: number;
  paid: boolean;
  busy?: boolean;
  /** A refusal worth showing in place of the button, e.g. a raced balance. */
  notice?: string | null;
  /**
   * A live hour this purchase does not match. Present means the purchase is
   * blocked until that hour is ended, so only the replace action is offered.
   */
  conflict?: string | null;
  onStart: () => void;
  /** Ends the live hour, then buys this one. */
  onReplace?: () => void;
  onClose: () => void;
}

export default function PricingDialog({
  modeLabel,
  priceDew,
  balance,
  dailyRemaining,
  paid,
  busy = false,
  notice = null,
  conflict = null,
  onStart,
  onReplace,
  onClose,
}: PricingDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [busy, onClose]);

  const wallet = Math.max(0, Math.round((balance - dailyRemaining) * 1000) / 1000);
  const canStart = balance >= priceDew;
  const coveredByFree = dailyRemaining >= priceDew;
  const fromWallet = Math.max(0, Math.round((priceDew - dailyRemaining) * 1000) / 1000);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Start an hour session"
      className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-sm sm:p-8"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="animate-pop relative my-auto w-full max-w-md rounded-[28px] border border-[#2f6b48]/25 bg-[#111a16] p-6 shadow-[0_0_60px_-20px_rgba(47,107,72,0.8)] sm:p-7"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="lift absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.07] text-white/70 transition-colors hover:bg-white/[0.14] hover:text-white disabled:opacity-40"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
          </svg>
        </button>

        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a9d8bb]/70">{modeLabel}</p>
        <h2 className="mt-1 pr-10 text-[19px] font-semibold leading-tight tracking-tight">
          {formatDew(priceDew)} Dew for an hour
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/50">
          Free {formatDew(dailyRemaining)}
          {wallet > 0 ? ` · Wallet ${formatDew(wallet)}` : ""}
          {paid ? " · Paid pass" : ""}
        </p>

        {notice && (
          <p className="mt-3 rounded-[14px] border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-amber-100/80">
            {notice}
          </p>
        )}

        {conflict ? (
          <>
            <p className="mt-4 rounded-[14px] border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-amber-100/80">
              {conflict}
            </p>
            {canStart && onReplace && (
              <button
                type="button"
                onClick={onReplace}
                disabled={busy}
                className="mt-3 w-full rounded-full border border-amber-300/30 py-3 text-[14px] font-semibold text-amber-100 transition-colors hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="inline-flex items-center justify-center gap-2">
                  {busy && <Spinner size={14} className="text-amber-100" />}
                  {busy ? "Ending the hour…" : `End it and start an hour for ${modeLabel}`}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="mt-2 w-full rounded-full py-2.5 text-[13px] font-medium text-white/60 transition-colors hover:text-white disabled:opacity-40"
            >
              Keep the active hour
            </button>
          </>
        ) : canStart ? (
          <>
            <div className="mt-4 rounded-[14px] border border-white/[0.07] bg-black/20 px-3 py-2.5">
              {coveredByFree ? (
                <p className="text-[11.5px] leading-relaxed text-white/50">Free Dew covers this hour.</p>
              ) : (
                <p className="text-[11.5px] leading-relaxed text-white/55">
                  Wallet pays {formatDew(fromWallet)} Dew.
                </p>
              )}
            </div>

            <button
              type="button"
              onClick={onStart}
              disabled={busy}
              className="mt-4 w-full rounded-full bg-white py-3 text-[14.5px] font-semibold text-black transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
            >
              <span className="inline-flex items-center justify-center gap-2">
                {busy && <Spinner size={15} className="text-black/70" />}
                {busy ? "Starting…" : `Start the hour — ${formatDew(priceDew)} Dew`}
              </span>
            </button>
          </>
        ) : (
          <>
            <p className="mt-4 rounded-[14px] border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-amber-100/80">
              Needs {formatDew(priceDew)} Dew. You have {formatDew(balance)}.
            </p>
            <Link
              href="/plus"
              className="mt-3 flex w-full items-center justify-center rounded-full bg-white py-3 text-[14px] font-semibold text-black"
            >
              Open the Dew wallet
            </Link>
          </>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-white/35">
          <Link href="/plus" className="transition-colors hover:text-white/70">
            Dew wallet &amp; paid pass
          </Link>
          <button type="button" onClick={onClose} disabled={busy} className="transition-colors hover:text-white/70">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
