"use client";

import {
  MODE_CATEGORIES,
  OPENMI_MODES,
  categoryOfMode,
  type ModeCategoryId,
  type ModeId,
} from "@/lib/models";
import { authHeader } from "@/lib/supabase";
import { useEffect, useRef, useState } from "react";

// ── Choosing how much answer to buy ──────────────────────────────────────────
//
// The menu used to lead with three model names, which asked a person to know
// what a model name means before they could pick one. It now asks the question
// they actually have — how much should this answer cost — and groups the models
// under Efficient, Balanced and Advanced.
//
// A category is a door, not a choice: pressing it reveals the model it holds,
// and the model is what gets selected. That keeps the name on screen at the
// moment it matters, so a person can still see exactly which engine an answer
// came from, which is also what the stored message labels.

interface ModeSelectorProps {
  selected: ModeId;
  onChange: (mode: ModeId) => void;
  available: ModeId[];
}

export default function ModeSelector({ selected, onChange }: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  // Which category is unfolded. The current model's category is opened when the
  // menu opens, so the thing already in use is never two clicks away.
  const [expanded, setExpanded] = useState<ModeCategoryId | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeMode = OPENMI_MODES.find((mode) => mode.id === selected) ?? OPENMI_MODES[0];
  const activeCategory = categoryOfMode(selected);

  useEffect(() => {
    const refresh = () => {
      // The answer depends on who is asking: a mode can be usable through the
      // account's own key even when this deployment has none.
      void authHeader()
        .then((headers) => fetch("/api/chat", { headers }))
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { available?: ModeId[]; searchAvailable?: boolean; contextBudget?: number } | null) => {
          if (data?.available) {
            window.dispatchEvent(new CustomEvent("openmi:availability", {
              detail: {
                available: data.available,
                searchAvailable: Boolean(data.searchAvailable),
                // The token budget the server enforces, so the ring and the
                // server's refusal cannot disagree.
                contextBudget: data.contextBudget,
              },
            }));
          }
        })
        .catch(() => undefined);
    };

    refresh();
    // Adding or removing a key in Settings changes which modes can answer, and
    // the picker is already mounted: without this it would keep offering the
    // old answer until a reload.
    window.addEventListener("openmi:keys-changed", refresh);
    return () => window.removeEventListener("openmi:keys-changed", refresh);
  }, []);

  const toggleMenu = () => {
    setOpen((value) => {
      const next = !value;
      // Opening lands on the current model's category; closing forgets the
      // expansion so the next open is not a stale section.
      setExpanded(next ? activeCategory.id : null);
      return next;
    });
  };

  const selectMode = (mode: ModeId) => {
    onChange(mode);
    setOpen(false);
    setExpanded(null);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggleMenu}
        className="group flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-card px-3 text-[13px] font-medium text-text-body transition-colors hover:bg-hover active:scale-[0.985]"
        aria-label="Switch model"
        aria-expanded={open}
      >
        <span className="max-w-[140px] truncate sm:max-w-none">{activeMode.display}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-text-low transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m7 10 5 5 5-5" />
        </svg>
      </button>

      {open && (
        <div
          role="radiogroup"
          aria-label="Openmi model"
          className="animate-pop absolute right-0 top-full z-50 mt-1.5 w-64 origin-top-right overflow-hidden rounded-xl border border-line bg-card p-1 shadow-2xl backdrop-blur-xl"
        >
          {MODE_CATEGORIES.map((category) => {
            const isExpanded = expanded === category.id;
            const inUse = category.id === activeCategory.id;
            const mode = OPENMI_MODES.find((entry) => entry.id === category.mode) ?? OPENMI_MODES[0];
            const active = selected === mode.id;
            return (
              <div key={category.id} className="rounded-lg">
                <button
                  type="button"
                  onClick={() => setExpanded(isExpanded ? null : category.id)}
                  aria-expanded={isExpanded}
                  aria-controls={`model-category-${category.id}`}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    inUse ? "bg-hover" : "hover:bg-hover"
                  }`}
                >
                  {/* The name and nothing else: the category is a door, and a
                      sentence under it only delayed the model behind it. */}
                  <span
                    className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${
                      inUse ? "text-text-hi" : "text-text-body"
                    }`}
                  >
                    {category.label}
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`shrink-0 text-text-low transition-transform ${isExpanded ? "rotate-180" : ""}`}
                  >
                    <path d="m7 10 5 5 5-5" />
                  </svg>
                </button>

                {isExpanded && (
                  <div id={`model-category-${category.id}`} className="px-1 pb-1">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => selectMode(mode.id)}
                      className={`flex w-full cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                        active
                          ? "border-accent/35 bg-accent/[0.08]"
                          : "border-line bg-card hover:border-accent/25 hover:bg-hover"
                      }`}
                    >
                      <span
                        className={`min-w-0 flex-1 truncate text-[13px] font-medium ${
                          active ? "text-text-hi" : "text-text-body"
                        }`}
                      >
                        {mode.display}
                      </span>
                      {active && (
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="mt-0.5 shrink-0 text-accent"
                          aria-hidden="true"
                        >
                          <path d="m5 12 4 4L19 6" />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
