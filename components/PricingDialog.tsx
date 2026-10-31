"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDew } from "@/lib/dew";

// ── Pay for the hour, or for the message ────────────────────────────────────
//
// Shown before the first message of a new chat, because that is the only moment
// the choice is still a choice: once an hour is running it covers every answer
// in that chat, and once a message is sent it is billed per request.
//
// The wallet question lives here rather than in the server copy on purpose. The
// charge itself already spends today's free Dew first and the paid wallet after
// it; this dialog only asks whether the person wants that split, and it does not
// offer the option at all when free Dew plus wallet still cannot cover the
// price. A confirmation is therefore an acknowledgement, not a permission the
// server trusts.
//
// The prices come from props, which come from the server's price list through
// the chat page. A modified client can change them on screen, but not what
// `start_hour_session()` or the chat route charges.

export interface PricingConflict {
  chatId: string;
  /** The chat's title in this browser, for the sentence that names it. */
  chatLabel: string;
  expiresAt: number;
}

export type PricingChoice = "hour" | "request";

export interface PricingDialogProps {
  modeLabel: string;
  sessionDew: number;
  requestDew: number;
  /** Spendable now: today's free Dew plus the paid wallet. */
  balance: number;
  dailyRemaining: number;
  paid: boolean;
  busy?: boolean;
  /** A refusal worth showing in place of the options, e.g. a raced balance. */
  notice?: string | null;
  /** Set when the server refused a second session and named the live one. */
  conflict?: PricingConflict | null;
  onChoose: (choice: PricingChoice) => void;
  onContinueConflict?: () => void;
  onEndAndStart?: () => void;
  /** The escape hatch while another chat owns the hour: send this one per request. */
  onRequestInstead?: () => void;
  onClose: () => void;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function PricingDialog({
  modeLabel,
  sessionDew,
  requestDew,
  balance,
  dailyRemaining,
  paid,
  busy = false,
  notice = null,
  conflict = null,
  onChoose,
  onContinueConflict,
  onEndAndStart,
  onRequestInstead,
  onClose,
}: PricingDialogProps) {
  const [choice, setChoice] = useState<PricingChoice>("request");
  const [combine, setCombine] = useState(false);

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
  const price = choice === "hour" ? sessionDew : requestDew;
  const coveredByFree = dailyRemaining >= price;
  const fromWallet = Math.max(0, Math.round((price - dailyRemaining) * 1000) / 1000);
  const canHour = balance >= sessionDew;
  const canRequest = balance >= requestDew;
  const anyAffordable = canHour || canRequest;
  const needsWallet = !coveredByFree && fromWallet > 0 && balance >= price;
  // The option is only offered when free + wallet can cover it. There is no
  // half-payment: if both are short, the answer is a top-up, not a button that
  // fails on the server.
  const options = [
    {
      id: "request" as const,
      title: "Just this message",
      price: requestDew,
      blurb: "Billed once for this answer, then again for the next.",
      available: canRequest,
    },
    {
      id: "hour" as const,
      title: "1 hour session",
      price: sessionDew,
      blurb: "Covers every answer in this chat for the next hour.",
      available: canHour,
    },
  ].filter((option) => option.available);

  useEffect(() => {
    // Keep the selection on an option that still exists.
    if (!options.some((option) => option.id === choice)) {
      setChoice(options[0]?.id ?? "request");
    }
  }, [choice, options]);

  const confirm = () => {
    if (busy || needsWallet) return;
    onChoose(choice);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose how to pay for this chat"
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

        {conflict ? (
          <>
            <h2 className="pr-10 text-[19px] font-semibold leading-tight tracking-tight">An hour is already running</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-white/60">
              Your session in <span className="font-medium text-white">{conflict.chatLabel}</span> is active until{" "}
              <span className="font-medium text-white">{clock(conflict.expiresAt)}</span>. Continue there, or end it
              before starting a new hour here.
            </p>
            <div className="mt-5 space-y-2">
              <button
                type="button"
                onClick={onContinueConflict}
                disabled={busy}
                className="w-full rounded-full bg-white py-3 text-[14px] font-semibold text-black transition-transform disabled:opacity-50 disabled:hover:scale-100"
              >
                Continue in that chat
              </button>
              <button
                type="button"
                onClick={onEndAndStart}
                disabled={busy}
                className="w-full rounded-full border border-[#2f6b48]/40 bg-[#2f6b48]/15 py-3 text-[14px] font-semibold text-[#d7f0e1] transition-colors hover:bg-[#2f6b48]/25 disabled:opacity-50"
              >
                End it and start a new hour here
              </button>
              {onRequestInstead && (
                <button
                  type="button"
                  onClick={onRequestInstead}
                  disabled={busy || !canRequest}
                  className="w-full rounded-full border border-white/[0.12] py-3 text-[13px] font-medium text-white/70 transition-colors hover:border-white/25 hover:text-white disabled:opacity-40"
                >
                  Just send this one — {formatDew(requestDew)} Dew
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="mt-3 w-full rounded-full py-2 text-[12.5px] text-white/45 transition-colors hover:text-white/75 disabled:opacity-40"
            >
              Not now
            </button>
          </>
        ) : (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#a9d8bb]/70">{modeLabel}</p>
            <h2 className="mt-1 pr-10 text-[19px] font-semibold leading-tight tracking-tight">
              How would you like this chat?
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-white/50">
              You have <span className="font-medium text-white/85">{formatDew(dailyRemaining)} free Dew</span> today
              {wallet > 0 ? ` and ${formatDew(wallet)} in your wallet` : ""}
              {paid ? " · paid pass active" : ""}.
            </p>

            {notice && (
              <p className="mt-3 rounded-[14px] border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-amber-100/80">
                {notice}
              </p>
            )}

            {anyAffordable ? (
              <>
                <div role="radiogroup" aria-label="Payment" className="mt-4 space-y-2">
                  {options.map((option) => {
                    const active = choice === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setChoice(option.id)}
                        className={`w-full rounded-[18px] border p-3.5 text-left transition-colors ${
                          active
                            ? "border-[#2f6b48]/60 bg-[#2f6b48]/[0.14]"
                            : "border-white/[0.09] bg-white/[0.03] hover:border-white/[0.16]"
                        }`}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="text-[13.5px] font-semibold text-white">{option.title}</span>
                          <span className="ml-auto shrink-0 text-[13px] font-semibold text-[#a9d8bb]">
                            {formatDew(option.price)} Dew
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-white/45">{option.blurb}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-3 rounded-[14px] border border-white/[0.07] bg-black/20 px-3 py-2.5">
                  {coveredByFree ? (
                    <p className="text-[11.5px] leading-relaxed text-white/50">
                      Today&apos;s free Dew covers this — your wallet is not touched.
                    </p>
                  ) : (
                    <>
                      <p className="text-[11.5px] leading-relaxed text-white/55">
                        Your free Dew covers {formatDew(Math.min(dailyRemaining, price))}; the other{" "}
                        <span className="font-medium text-white">{formatDew(fromWallet)} Dew</span> would come from your
                        wallet.
                      </p>
                      <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11.5px] leading-relaxed text-white/70">
                        <input
                          type="checkbox"
                          checked={combine}
                          onChange={(event) => setCombine(event.target.checked)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#2f6b48]"
                        />
                        Combine the cost with my wallet for this one.
                      </label>
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={confirm}
                  disabled={busy || needsWallet}
                  className="mt-4 w-full rounded-full bg-white py-3 text-[14.5px] font-semibold text-black transition-transform hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:scale-100"
                >
                  {busy
                    ? "Starting…"
                    : choice === "hour"
                      ? `Start the hour — ${formatDew(sessionDew)} Dew`
                      : `Send for ${formatDew(requestDew)} Dew`}
                </button>
              </>
            ) : (
              <>
                <p className="mt-4 rounded-[14px] border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-[12px] leading-relaxed text-amber-100/80">
                  That needs {formatDew(requestDew)} Dew and you have {formatDew(balance)} left. Top up to choose a
                  price, or come back after your daily Dew refills.
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
          </>
        )}
      </div>
    </div>
  );
}
