"use client";

// ── The suggestion bar above the composer ────────────────────────────────────
//
// One row of small, self-explanatory prompts that sit directly above the input
// dock, in the place a thumb already is. They are chips rather than a panel:
// a single horizontal strip that scrolls sideways with the scrollbar hidden, so
// the row costs one line of height on a phone.
//
// A chip does not send anything. It writes its prompt into the composer and
// leaves the cursor there — every request costs Dew, so a stray tap must never
// spend any. The wording is the start of a question, not the whole of one.

import type { ReactNode } from "react";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

interface QuickAction {
  label: string;
  prompt: string;
  icon: ReactNode;
}

const ACTIONS: QuickAction[] = [
  {
    label: "Explain this repo",
    prompt: "Explain what this repository does and how the main pieces fit together.",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z" />
        <path d="M8 7.5h7M8 11h5" />
      </svg>
    ),
  },
  {
    label: "Find a bug",
    prompt: "Look through this code and point out the most likely bug, with the file and the line.",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M8 8h8v6a4 4 0 0 1-8 0z" />
        <path d="M9 8V6a3 3 0 0 1 6 0v2M4 11h4M16 11h4M5 17l3-2M19 17l-3-2M6 20l2.5-1.5M18 20l-2.5-1.5" />
      </svg>
    ),
  },
  {
    label: "Review changes",
    prompt: "Review the changes in this repository and tell me what I should fix before merging.",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M12 3.5 19 6v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
        <path d="m8.8 11.8 2.2 2.2 4.2-4.4" />
      </svg>
    ),
  },
  {
    label: "Write a test",
    prompt: "Write a test for the most important behaviour in this repository that is not covered yet.",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M9 3.5h6M10.5 3.5v6L5.8 18a2 2 0 0 0 1.7 3h9a2 2 0 0 0 1.7-3l-4.7-8.5v-6" />
        <path d="M7.5 15h9" />
      </svg>
    ),
  },
  {
    label: "Plan a feature",
    prompt: "Help me plan a small feature: which files it touches, and the order I should do the work in.",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M5 5h6v6H5zM13 13h6v6h-6z" />
        <path d="M11 8h4a2 2 0 0 1 2 2v3M13 16H9a2 2 0 0 1-2-2v-3" />
      </svg>
    ),
  },
  {
    label: "Summarise a file",
    prompt: "Summarise this file and tell me what would break if it changed: ",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <path d="M6 3.5h8l4 4v13H6z" />
        <path d="M14 3.5v4h4M9 12h6M9 15.5h4" />
      </svg>
    ),
  },
];

export default function QuickActions({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div
      className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 pb-2 md:mx-0 md:px-0"
      role="group"
      aria-label="Suggested prompts"
    >
      {ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          onClick={() => onPick(action.prompt)}
          className="quick-chip"
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}
