"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MaintenanceGate from "@/components/MaintenanceGate";
import { authHeader } from "@/lib/supabase";
import { shareUrl, type ShareSummary } from "@/lib/share";

// ── Links that were sent out ────────────────────────────────────────────────
//
// The share button copies a link and moves on; this is where an owner can see
// every link that came from their account and take one back. Revoking is
// immediate — the public page reads a view that excludes revoked rows — and the
// row stays here so "I revoked that" is a fact rather than a disappearing act.

function formatDay(epoch: number): string {
  if (!Number.isFinite(epoch) || epoch <= 0) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(epoch));
}

function statusOf(share: ShareSummary, now: number): { label: string; className: string } {
  if (share.revoked) return { label: "Revoked", className: "bg-white/[0.06] text-white/40" };
  if (share.expiresAt > 0 && share.expiresAt <= now) {
    return { label: "Expired", className: "bg-amber-400/10 text-amber-200/80" };
  }
  return { label: "Active", className: "bg-[#a9d8bb]/10 text-[#a9d8bb]" };
}

export default function SharesPage() {
  return (
    <MaintenanceGate>
      <SharesContent />
    </MaintenanceGate>
  );
}

function SharesContent() {
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/share", {
        headers: await authHeader(),
        cache: "no-store",
      });
      const data = (await response.json().catch(() => ({}))) as {
        shares?: ShareSummary[];
        error?: string;
      };
      if (!response.ok) {
        setError(
          response.status === 401
            ? "Sign in to see the links you have shared."
            : data.error ?? "Your links could not be loaded."
        );
        setShares([]);
        return;
      }
      setShares(Array.isArray(data.shares) ? data.shares : []);
      setError(null);
    } catch {
      setError("Your links could not be reached. Try again.");
      setShares([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async (share: ShareSummary) => {
    try {
      await navigator.clipboard.writeText(shareUrl(window.location.origin, share.id));
      setCopiedId(share.id);
      window.setTimeout(() => setCopiedId((current) => (current === share.id ? null : current)), 2_000);
    } catch {
      setError("The link could not be copied automatically — open it and copy from the address bar.");
    }
  };

  const revoke = async (share: ShareSummary) => {
    if (busyId) return;
    setBusyId(share.id);
    setError(null);
    try {
      const response = await fetch(`/api/share/${share.id}`, {
        method: "DELETE",
        headers: await authHeader(),
        cache: "no-store",
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "That link could not be revoked.");
        return;
      }
      setShares((current) =>
        current ? current.map((row) => (row.id === share.id ? { ...row, revoked: true } : row)) : current
      );
    } catch {
      setError("That link could not be revoked. Try again.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="min-h-dvh bg-[#0b1310] px-5 pb-12 pt-[max(1rem,env(safe-area-inset-top))] text-white sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <Link
          href="/chat"
          aria-label="Back to Openmi"
          className="lift mb-6 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.07] text-white/80 transition-colors hover:bg-white/[0.12] hover:text-white"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5.5 8.5 12l6.5 6.5" />
          </svg>
        </Link>

        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#a9d8bb]/70">Sharing</p>
        <h1 className="mt-1 text-[clamp(1.9rem,7vw,2.7rem)] font-semibold leading-[1.05] tracking-tight">
          Links you sent
        </h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-white/45">
          Each link is a copy of one answer, not a window into the chat. They expire after thirty days, and
          revoking one stops it immediately.
        </p>

        {error && (
          <div className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-400/[0.05] px-4 py-3 text-[12.5px] text-amber-100/80">
            {error}
          </div>
        )}

        {shares === null && !error && <p className="mt-8 text-[13px] text-white/40">Reading your links…</p>}

        {shares && shares.length === 0 && !error && (
          <div className="mt-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-5 text-[13px] leading-relaxed text-white/45">
            Nothing shared yet. Open a finished answer in a chat and use the share button.
          </div>
        )}

        {shares && shares.length > 0 && (
          <ul className="mt-6 space-y-2.5">
            {shares.map((share) => {
              const status = statusOf(share, now);
              return (
                <li
                  key={share.id}
                  className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium text-white/85">{share.title}</p>
                      <p className="mt-1 text-[10.5px] text-white/35">
                        Created {formatDay(share.createdAt)} · expires {formatDay(share.expiresAt)}
                      </p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] ${status.className}`}>
                      {status.label}
                    </span>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void copy(share)}
                      className="rounded-lg border border-white/[0.1] px-2.5 py-1 text-[11px] text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                      {copiedId === share.id ? "Copied" : "Copy link"}
                    </button>
                    <Link
                      href={`/share/${share.id}`}
                      target="_blank"
                      className="rounded-lg border border-white/[0.1] px-2.5 py-1 text-[11px] text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white"
                    >
                      Open
                    </Link>
                    {!share.revoked && (
                      <button
                        type="button"
                        onClick={() => void revoke(share)}
                        disabled={busyId === share.id}
                        className="rounded-lg border border-red-300/15 px-2.5 py-1 text-[11px] text-red-200/75 transition-colors hover:bg-red-400/10 disabled:opacity-40"
                      >
                        {busyId === share.id ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
