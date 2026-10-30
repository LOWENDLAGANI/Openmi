"use client";

import { useEffect, useRef, useState } from "react";
import { contextLabel, formatTokens, type ContextUsage } from "@/lib/contextBudget";

// ── The context ring ─────────────────────────────────────────────────────────
// One SVG, two arcs, no chart dependency — the same technique as the Dew drop
// on the pricing page. It answers "how full is this conversation?" in a corner
// of the composer that costs no vertical space, and opens into the arithmetic
// rather than a tooltip that says "nearly full".
//
// The percentage is always available to a screen reader: the button's label
// carries the used and budget token counts, so the ring is never a shape whose
// meaning is only in the colour.

interface ContextRingProps {
  usage: ContextUsage;
  /** An answer is in flight, so the last known number is being extended. */
  streaming?: boolean;
  onNewChat?: () => void;
  /** A temporary thread can still start a fresh chat; this guards future callers. */
  canStartNewChat?: boolean;
}

const SIZE = 26;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Ring and bar agree on the colour for each band. The healthy band is the
 *  theme's accent rather than a fixed sage, so the ring follows the palette. */
function toneColor(level: ContextUsage["level"]): string {
  if (level === "full") return "#ef6b6b";
  if (level === "warn") return "#f5b544";
  return "var(--accent)";
}

export default function ContextRing({
  usage,
  streaming = false,
  onNewChat,
  canStartNewChat = true,
}: ContextRingProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // A popover, not a dialog: it dismisses on an outside tap and on Escape, and
  // it never traps focus or covers the message being composed.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const color = toneColor(usage.level);
  const dashOffset = CIRCUMFERENCE * (1 - usage.percent / 100);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${contextLabel(usage)} Open the context breakdown.`}
        title="Context budget"
        className={`flex h-7 items-center gap-1.5 rounded-full pl-1 pr-1.5 transition-colors hover:bg-hover ${
          usage.level === "empty" ? "text-text-low" : "text-text-mid"
        }`}
      >
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="shrink-0"
          aria-hidden="true"
          focusable="false"
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            opacity={0.18}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            style={{ stroke: color }}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            className={streaming ? "animate-pulse" : undefined}
          />
        </svg>
        <span className="font-mono text-[10px] tabular-nums">{usage.percent}%</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Context breakdown"
          className="animate-pop absolute bottom-full right-0 z-50 mb-2 w-[270px] rounded-xl border border-line bg-card p-3 shadow-2xl backdrop-blur-xl"
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-text-low">
              Context
            </p>
            <p className="font-mono text-[10.5px] text-text-mid">
              {formatTokens(usage.used)} / {formatTokens(usage.budget)} tok
            </p>
          </div>

          {usage.parts.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {usage.parts.map((part) => (
                <li
                  key={part.label}
                  className="flex items-baseline justify-between gap-2 text-[12px] text-text-body"
                >
                  <span className="truncate">{part.label}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-text-mid">
                    {formatTokens(part.tokens)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[12px] leading-relaxed text-text-mid">
              Nothing sent yet. The ring fills as the conversation grows.
            </p>
          )}

          <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
            <div
              className="h-full rounded-full transition-[width] duration-500"
              style={{ width: `${usage.percent}%`, backgroundColor: color }}
            />
          </div>

          <p className="mt-2 text-[10.5px] leading-relaxed text-text-low">
            Approximate. “Last request” is the prompt the server actually sent — system prompt,
            conversation and any web or repository context included.
          </p>

          {usage.level === "full" && onNewChat && (
            <button
              type="button"
              disabled={!canStartNewChat}
              onClick={() => {
                setOpen(false);
                onNewChat();
              }}
              className="mt-2.5 w-full rounded-lg border border-[#a9d8bb]/25 bg-[#a9d8bb]/10 px-2 py-1.5 text-[11.5px] font-medium text-[#c9e7d5] transition-colors hover:bg-[#a9d8bb]/15 disabled:opacity-40"
            >
              Start a new chat
            </button>
          )}
        </div>
      )}
    </div>
  );
}
