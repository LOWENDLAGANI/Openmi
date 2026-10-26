
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MaintenanceGate from "@/components/MaintenanceGate";
import { authHeader } from "@/lib/supabase";
import { DAILY_FREE_DEW, formatDew, requestPrice } from "@/lib/dew";
import type { DewActivity } from "@/lib/dewActivity";

// ── Where the Dew went ───────────────────────────────────────────────────────
//
// The top-up page answers "how much is left". This page answers the question
// behind it: "why". Every number comes from the ledger the server already keeps,
// grouped in the account's own timezone so a day here is the same day that
// refilled the free bucket.
//
// It is read only. There is nothing to buy, claim or change — just the record,
// which is what makes a prepaid currency feel like a bill rather than a slot
// machine.

interface ActivityResponse {
  balance: number;
  dailyRemaining: number;
  timeZone: string;
  activity: DewActivity;
}

function shortDay(day: string): string {
  return day.slice(5).replace("-", "/");
}

function modelLabel(model: string): string {
  if (model === "auto") return "Auto";
  if (model === "code") return "Code";
  if (model === "flash") return "DeepSeek V4.1 Flash";
  if (model === "unknown") return "Unrecorded";
  return model;
}

function creditLabel(code: string): string {
  if (code === "TRIAL") return "Welcome Dew";
  if (code.startsWith("TOPUP")) return "Top-up";
  if (code.startsWith("REFERRAL")) return "Referral";
  return code;
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] px-4 py-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/35">{label}</p>
      <p className="mt-1 text-[22px] font-semibold leading-tight tracking-tight text-white">{value}</p>
      {note ? <p className="mt-0.5 text-[11px] text-white/40">{note}</p> : null}
    </div>
  );
}

export default function ActivityPage() {
  return (
    <MaintenanceGate>
      <ActivityContent />
    </MaintenanceGate>
  );
}

function ActivityContent() {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/dew/activity", {
          headers: await authHeader(),
          cache: "no-store",
        });
        if (!response.ok) {
          if (cancelled) return;
          setError(
            response.status === 401
              ? "Sign in to see where your Dew went."
              : "Your activity could not be loaded right now."
          );
          return;
        }
        const payload = (await response.json()) as ActivityResponse;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setError("Your activity could not be reached. Check the connection and try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activity = data?.activity;
  const maxDay = activity ? Math.max(0.0001, ...activity.days.map((day) => day.spend)) : 0;
  const freeShare =
    activity && activity.totals.spend > 0
      ? Math.round((activity.totals.free / activity.totals.spend) * 100)
      : 0;
  const recentDays = activity ? activity.days.slice(-14) : [];

  return (
    <main className="min-h-dvh bg-[#0b1310] px-5 pb-12 pt-[max(1rem,env(safe-area-inset-top))] text-white sm:px-8">
      <div className="mx-auto w-full max-w-2xl lg:max-w-3xl">
        <Link
          href="/plus"
          aria-label="Back to Dew"
          className="lift mb-6 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.07] text-white/80 transition-colors hover:bg-white/[0.12] hover:text-white"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5.5 8.5 12l6.5 6.5" />
          </svg>
        </Link>

        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#a9d8bb]/70">Dew</p>
        <h1 className="mt-1 text-[clamp(1.9rem,7vw,2.7rem)] font-semibold leading-[1.05] tracking-tight">
          Where it went
        </h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-white/45">
          Your last 30 days dew usage 
        </p>

        {error && (
          <div className="mt-6 rounded-2xl border border-amber-300/20 bg-amber-400/[0.05] px-4 py-4 text-[13px] text-amber-100/80">
            {error}
          </div>
        )}

        {!data && !error && (
          <p className="mt-8 text-[13px] text-white/40">Reading the ledger…</p>
        )}

        {data && activity && (
          <>
            <section className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat label="Balance" value={formatDew(data.balance)} note={`${formatDew(data.dailyRemaining)} free today`} />
              <Stat label="Spent" value={formatDew(activity.totals.spend)} note={`${activity.totals.requests} requests`} />
              <Stat label="Free / paid" value={`${freeShare}% free`} note={`${formatDew(activity.totals.free)} free · ${formatDew(activity.totals.paid)} paid`} />
              <Stat label="This month" value={formatDew(activity.totals.thisMonth)} note={activity.totals.month} />
            </section>

            <section className="mt-6 rounded-[22px] border border-white/[0.07] bg-white/[0.02] p-4 sm:p-5">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-[13px] font-semibold text-white/85">Last 14 days</h2>
                <span className="text-[11px] text-white/35">highest {formatDew(maxDay)} Dew</span>
              </div>
              <ul className="mt-3 space-y-1.5">
                {recentDays.map((day) => (
                  <li key={day.day} className="flex items-center gap-3 text-[12px]">
                    <span className="w-11 shrink-0 font-mono text-[10.5px] text-white/35">{shortDay(day.day)}</span>
                    <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#2f6b48] to-[#a9d8bb]"
                        style={{ width: `${day.spend > 0 ? Math.max(3, (day.spend / maxDay) * 100) : 0}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-white/55">
                      {day.spend > 0 ? `${formatDew(day.spend)}` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
              {activity.totals.requests === 0 && (
                <p className="mt-3 text-[12px] text-white/35">
                  No requests in this window yet. The free {formatDew(DAILY_FREE_DEW)} Dew a day is
                  still there to use.
                </p>
              )}
            </section>

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <section className="rounded-[22px] border border-white/[0.07] bg-white/[0.02] p-4 sm:p-5">
                <h2 className="text-[13px] font-semibold text-white/85">By model</h2>
                {activity.models.length === 0 ? (
                  <p className="mt-2 text-[12px] text-white/35">Nothing charged yet.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {activity.models.map((model) => (
                      <li key={model.model} className="flex items-center justify-between gap-3 text-[12px]">
                        <span className="text-white/70">{modelLabel(model.model)}</span>
                        <span className="text-white/40">
                          {model.requests} {model.requests === 1 ? "request" : "requests"} ·{" "}
                          <span className="text-white/65">{formatDew(model.spend)} Dew</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-[22px] border border-white/[0.07] bg-white/[0.02] p-4 sm:p-5">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-[13px] font-semibold text-white/85">Added to the wallet</h2>
                  <span className="text-[11px] text-white/35">{formatDew(activity.creditTotal)} Dew</span>
                </div>
                {activity.credits.length === 0 ? (
                  <p className="mt-2 text-[12px] text-white/35">No top-ups or codes in this window.</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {activity.credits.slice(0, 8).map((credit, index) => (
                      <li key={`${credit.at}-${credit.code}-${index}`} className="flex items-center justify-between gap-3 text-[12px]">
                        <span className="truncate text-white/70">{creditLabel(credit.code)}</span>
                        <span className="shrink-0 text-[#a9d8bb]/80">+{formatDew(credit.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[12px] text-white/35">
              <p>
                The price is same for every request
              </p>
              <Link href="/plus" className="text-[#a9d8bb]/80 transition-colors hover:text-[#a9d8bb]">
                Top up Dew →
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
