"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MaintenanceGate from "@/components/MaintenanceGate";
import RedeemCodeBox from "@/components/RedeemCodeBox";
import DewQrDialog from "@/components/DewQrDialog";
import { watchAccount } from "@/lib/account";
import type { AccountView } from "@/lib/accountState";
import { getSupabase } from "@/lib/supabase";
import { useDew } from "@/lib/useDew";
import {
  DAILY_FREE_DEW,
  DEW_PACKS,
  formatDew,
  formatRinggit,
  type DewPack,
} from "@/lib/dew";
import {
  REFERRAL_DEW,
  REFERRAL_LIMIT,
  REFERRAL_STORAGE_KEY,
  normalizeReferralCode,
  referralErrorMessage,
  referralInviteUrl,
} from "@/lib/referral";

function DewPanel() {
  const { ready, balance, dailyRemaining, dailyTimeZone, refresh } = useDew();
  useEffect(() => {
    void (async () => {
      try {
        const { authHeader } = await import("@/lib/supabase");
        await fetch("/api/dew", { method: "POST", headers: await authHeader(), cache: "no-store" });
        await refresh();
      } catch {
        // Balance still shows; the absence of the trial is a balance of 0.
      }
    })();
  }, [refresh]);

  return (
    <section className="relative overflow-hidden rounded-[26px] border border-[#2f6b48]/30 bg-[#2f6b48]/[0.07] p-5 shadow-[0_0_50px_-20px_rgba(47,107,72,0.7)] sm:p-6">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#a9d8bb]/80">Your Dew</p>
      <h2 className="mt-1 text-[30px] font-semibold leading-tight tracking-tight">
        <span className="inline-flex items-center gap-1.5">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-[#a9d8bb]" aria-hidden="true">
            <path d="M12 2.7s6.6 7.1 6.6 11.6a6.6 6.6 0 1 1-13.2 0C5.4 9.8 12 2.7 12 2.7Z" />
          </svg>
          {ready ? formatDew(balance) : "…"}
        </span>
        <span className="text-[15px] font-normal text-white/50">Dew</span>
      </h2>
      <p className="mt-2 text-[12px] leading-relaxed text-white/50">
        {ready
          ? `${formatDew(dailyRemaining)} of ${formatDew(DAILY_FREE_DEW)} free Dew left today.`
          : `${formatDew(DAILY_FREE_DEW)} free Dew every day.`}{" "}
        Free Dew refills at midnight in your account&apos;s timezone
        {ready ? ` (${dailyTimeZone.replace(/_/g, " ")})` : ""} and whatever is left does not carry over.
      </p>
      <Link
        href="/activity"
        className="mt-2 inline-flex text-[12px] font-medium text-[#a9d8bb]/80 transition-colors hover:text-[#a9d8bb]"
      >
        See where your Dew went →
      </Link>
    </section>
  );
}

// ── Invite a friend ─────────────────────────────────────────────────────────
//
// The database owns the rules (one code, one claim, ten invites, a fixed
// reward). This panel only shows the code and asks. An invitation link is
// `/plus?ref=CODE`, so the recipient lands on the claim form already filled in
// once they sign in.

function ReferralPanel() {
  const { refresh } = useDew();
  const [code, setCode] = useState<string | null>(null);
  const [claimCode, setClaimCode] = useState("");
  const [claimNote, setClaimNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      let incoming = normalizeReferralCode(new URLSearchParams(window.location.search).get("ref"));
      if (!incoming) {
        incoming = normalizeReferralCode(window.localStorage.getItem(REFERRAL_STORAGE_KEY));
      }
      if (incoming) setClaimCode(incoming);
    } catch {
      // A malformed query string or blocked storage simply leaves the field empty.
    }

    void (async () => {
      try {
        const client = getSupabase();
        if (!client) return;
        const { data, error } = await client.rpc("ensure_referral_code");
        if (cancelled) return;
        if (error) setCode("");
        else if (typeof data === "string" && data) setCode(data);
        else setCode("");
      } catch {
        // The invitation card is a bonus; a deployment without it still works.
        if (!cancelled) setCode("");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const copyInvite = async () => {
    if (!code || typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(referralInviteUrl(window.location.origin, code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setClaimNote("The link could not be copied automatically — select it and copy it by hand.");
    }
  };

  const claim = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const normalised = normalizeReferralCode(claimCode);
    if (!normalised) {
      setClaimNote("Enter the invitation code you were given.");
      return;
    }
    setBusy(true);
    setClaimNote(null);
    try {
      const client = getSupabase();
      if (!client) {
        setClaimNote("Sign in before claiming an invitation.");
        return;
      }
      const { data, error } = await client.rpc("claim_referral", { p_code: normalised });
      if (error) {
        setClaimNote(referralErrorMessage(error));
        return;
      }
      const row = (Array.isArray(data) ? data[0] : data) as { referee_reward?: unknown } | null;
      const reward = Number(row?.referee_reward);
      try {
        window.localStorage.removeItem(REFERRAL_STORAGE_KEY);
      } catch {
        // Private mode: the code is gone with the page anyway.
      }
      await refresh();
      setClaimCode("");
      setClaimNote(
        `Invitation accepted — ${formatDew(Number.isFinite(reward) && reward > 0 ? reward : REFERRAL_DEW)} Dew added to both wallets.`
      );
    } catch (cause) {
      setClaimNote(referralErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  // Null while loading, empty when the feature is not available on this
  // deployment. Neither is worth a card that says "nothing here".
  if (!code) return null;
  const inviteUrl =
    typeof window === "undefined" ? "" : referralInviteUrl(window.location.origin, code);

  return (
    <section className="mt-4 rounded-[22px] border border-white/[0.07] bg-white/[0.025] p-4 sm:p-5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a9d8bb]/70">
        Invite a friend
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-white/50">
        You both get {formatDew(REFERRAL_DEW)} Dew when they join with your code. One invitation per
        account, up to {REFERRAL_LIMIT} per inviter.
      </p>

      <div className="mt-2.5 flex gap-2">
        <input
          readOnly
          value={inviteUrl}
          aria-label="Your invitation link"
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-black/25 px-2.5 py-2 font-mono text-[10.5px] text-white/60"
        />
        <button
          type="button"
          onClick={() => void copyInvite()}
          className="shrink-0 rounded-xl border border-[#a9d8bb]/25 px-3 py-2 text-[11.5px] font-medium text-[#a9d8bb] transition-colors hover:bg-[#a9d8bb]/10"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <form onSubmit={claim} className="mt-3 flex gap-2">
        <input
          value={claimCode}
          onChange={(event) => setClaimCode(event.target.value)}
          placeholder="Have a friend's code?"
          aria-label="Invitation code"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-xl border border-white/[0.08] bg-black/25 px-2.5 py-2 text-[12px] uppercase tracking-wide text-white placeholder:normal-case placeholder:tracking-normal placeholder:text-white/25"
        />
        <button
          type="submit"
          disabled={busy || !normalizeReferralCode(claimCode)}
          className="shrink-0 rounded-xl bg-[#2f6b48] px-3 py-2 text-[11.5px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Claiming…" : "Claim"}
        </button>
      </form>

      {claimNote && (
        <p className="mt-2 break-words text-[11.5px] leading-relaxed text-white/55">{claimNote}</p>
      )}
    </section>
  );
}

export default function OpenmiPlusPage() {
  const [dewTopUp, setDewTopUp] = useState<DewPack | null>(null);
  const [account, setAccount] = useState<AccountView | null>(null);
  useEffect(() => watchAccount((view) => setAccount(view)), []);

  // An invitation can arrive before there is a session. Keep the code for the
  // next visit and take it out of the address bar, so it is not lost when the
  // signed-out page sends the person to sign in.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const incoming = normalizeReferralCode(url.searchParams.get("ref"));
      if (!incoming) return;
      window.localStorage.setItem(REFERRAL_STORAGE_KEY, incoming);
      url.searchParams.delete("ref");
      window.history.replaceState({}, "", `${url.pathname}${url.search}`);
    } catch {
      // A blocked storage API must not stop the page rendering.
    }
  }, []);

  const canShowWallet = account?.status === "signed-in";

  return (
    <MaintenanceGate>
      <main className="min-h-dvh bg-[#0b1310] px-5 pb-10 pt-[max(1rem,env(safe-area-inset-top))] text-white sm:px-8">
        <div className="mx-auto w-full max-w-2xl lg:max-w-3xl">
          <Link
            href="/"
            aria-label="Back to Openmi"
            className="lift mb-6 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.07] text-white/80 transition-colors hover:bg-white/[0.12] hover:text-white"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M15 5.5 8.5 12l6.5 6.5" />
            </svg>
          </Link>

          <h1 className="text-[clamp(2.1rem,8vw,3.2rem)] font-semibold leading-[1.05] tracking-tight">
            Openmi <span className="bg-gradient-to-r from-[#2f6b48] via-[#a9d8bb] to-[#2f6b48] bg-clip-text text-transparent">Dew</span>
          </h1>


          {canShowWallet && (
            <>
              <DewPanel />
              <ReferralPanel />
            </>
          )}

          {!canShowWallet && (
            <div className="mt-6 rounded-[18px] border border-white/[0.08] bg-white/[0.03] px-4 py-4">
              <p className="text-[13.5px] leading-relaxed text-white/55">
                Sign in to see your balance and top up. A balance belongs to an account, so Openmi needs
                to know who it is before it can show one.
              </p>
              <Link
                href="/"
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white/[0.08] py-2.5 text-[13px] font-medium text-white transition hover:bg-white/[0.12]"
              >
                {account ? "Sign in to Openmi" : "Checking your account…"}
              </Link>
            </div>
          )}

          {canShowWallet && (
            <section className="mt-5">
              <h2 className="text-[15px] font-semibold text-white">Top up Dew</h2>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {DEW_PACKS.map((pack) => (
                  <button
                    key={pack.id}
                    type="button"
                    onClick={() => setDewTopUp(pack)}
                    className="group flex flex-col items-start gap-1 rounded-[18px] border border-white/[0.09] bg-white/[0.03] px-4 py-3.5 text-left transition-colors hover:border-[#2f6b48]/50 hover:bg-[#2f6b48]/[0.08]"
                  >
                    <span className="flex items-center gap-1.5 text-[15px] font-semibold text-white">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[#a9d8bb]" aria-hidden="true">
                        <path d="M12 2.7s6.6 7.1 6.6 11.6a6.6 6.6 0 1 1-13.2 0C5.4 9.8 12 2.7 12 2.7Z" />
                      </svg>
                      {formatDew(pack.dew)} Dew
                    </span>
                    <span className="text-[13px] font-medium text-white/70">
                      {formatRinggit(pack.ringgit)}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}



          {canShowWallet && (
            <div className="mt-5">
              <RedeemCodeBox />
            </div>
          )}
        </div>
      </main>

      {dewTopUp && <DewQrDialog key={dewTopUp.id} pack={dewTopUp} onClose={() => setDewTopUp(null)} />}
    </MaintenanceGate>
  );
}
