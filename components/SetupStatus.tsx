"use client";

// ── The setup banner ─────────────────────────────────────────────────────────
//
// One question, answered once per mount: what did this deployment forget?
//
// The list only ever contains what is missing. A key that has been set drops
// out of the answer the server gives, so the banner shrinks as the deployment
// fills in and disappears when there is nothing left to say — no ticks, no
// "already done" rows, no second list to compare against. That is the whole
// interaction model: the page is a to-do list, and a to-do list with crossed-off
// items on it is a worse to-do list.
//
// Nothing is shown while the answer is in flight. A banner that appears and
// then rewrites itself is worse than one that arrives complete, and for a
// deployment with nothing missing the two states are "blank" and "a green line
// saying so", which is not worth a flash between them.

import { useCallback, useEffect, useState } from "react";

interface SetupItem {
  keys: string[];
  label: string;
  missing: string;
  where: string;
  severity: "required" | "optional";
}

interface SetupReport {
  checked: number;
  configured: number;
  missing: SetupItem[];
}

export default function SetupStatus() {
  const [report, setReport] = useState<SetupReport | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/setup", { cache: "no-store" });
      if (!response.ok) return;
      setReport((await response.json()) as SetupReport);
    } catch {
      // A dropped request leaves the previous answer in place. Saying nothing
      // is better than telling an owner their keys are missing when the truth
      // is that the network blinked.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!report) return null;

  if (report.missing.length === 0) {
    return (
      <p className="mt-10 flex items-center justify-center gap-2 text-[11.5px] text-[#a9d8bb]/70">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
        All {report.checked} setup checks passed on this deployment.
      </p>
    );
  }

  const required = report.missing.filter((item) => item.severity === "required").length;

  return (
    <section
      aria-label="Setup"
      className="mt-10 rounded-xl border border-amber-300/20 bg-amber-400/[0.05] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-amber-100">
          {report.missing.length} of {report.checked} setup items are missing
        </h2>
        {required > 0 && (
          <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-amber-200/90">
            {required} required
          </span>
        )}
      </div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-amber-100/65">
        Openmi runs without them — each one shows a setup notice rather than crashing — but every item
        below takes a feature away until it is set.
      </p>

      <ul className="mt-3 space-y-2">
        {report.missing.map((item) => (
          <li
            key={item.keys.join("+")}
            className="rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              {item.keys.map((key) => (
                <code
                  key={key}
                  className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-[10.5px] text-amber-100/90"
                >
                  {key}
                </code>
              ))}
              <span className="text-[12px] font-medium text-white/80">{item.label}</span>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-white/55">{item.missing}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-white/35">
              <span className="text-white/45">Where:</span> {item.where}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10.5px] leading-relaxed text-white/30">
          Values live in the deployment environment, then the site is rebuilt — the NEXT_PUBLIC_ ones
          are inlined into the bundle at build time.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="shrink-0 rounded-lg border border-amber-200/25 px-2.5 py-1 text-[11px] font-medium text-amber-100/85 transition-colors hover:bg-amber-200/10"
        >
          Check again
        </button>
      </div>
    </section>
  );
}
