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

interface SchemaGap {
  migration: string;
  objects: string[];
}

interface DatabaseHealth {
  checked: boolean;
  reachable: boolean;
  checkedObjects: number;
  missing: SchemaGap[];
  message: string | null;
}

interface SetupReport {
  checked: number;
  configured: number;
  missing: SetupItem[];
  database?: DatabaseHealth;
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

  const database = report.database;
  const gaps = database?.missing ?? [];
  const schemaNeedsAttention = Boolean(database?.checked && (!database.reachable || gaps.length > 0));

  if (report.missing.length === 0 && !schemaNeedsAttention) {
    return null;
  }

  const required = report.missing.filter((item) => item.severity === "required").length;

  return (
    <section
      aria-label="Setup"
      className="mt-10 rounded-xl border border-amber-300/20 bg-amber-400/[0.05] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-amber-100">
          {report.missing.length > 0
            ? `${report.missing.length} of ${report.checked} setup items are missing`
            : "The database schema is not up to date"}
        </h2>
        {required > 0 && (
          <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] text-amber-200/90">
            {required} required
          </span>
        )}
      </div>
      {database?.checked && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2.5 ${
            schemaNeedsAttention
              ? "border-red-300/20 bg-red-400/[0.05]"
              : "border-emerald-300/15 bg-emerald-400/[0.04]"
          }`}
        >
          {!database.reachable ? (
            <p className="text-[12px] font-medium text-red-100">
              {database.message ?? "The schema check did not answer."}
            </p>
          ) : gaps.length > 0 ? (
            <>
              <p className="text-[12px] font-medium text-red-100">Missing migrations</p>
              <ul className="mt-2 space-y-1.5">
                {gaps.map((gap) => (
                  <li key={gap.migration} className="rounded-md bg-black/20 px-2 py-1.5">
                    <code className="font-mono text-[10.5px] text-red-100/90">{gap.migration}</code>
                    <p className="mt-0.5 break-words text-[10.5px] leading-relaxed text-white/40">
                      missing {gap.objects.join(", ")}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-[11.5px] leading-relaxed text-emerald-100/70">Schema up to date.</p>
          )}
        </div>
      )}

      {report.missing.length > 0 && (
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
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex justify-end">
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
