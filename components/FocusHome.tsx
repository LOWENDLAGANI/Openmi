"use client";

import type { ProjectSummary } from "@/lib/projects";

// ── Focus home: the empty screen of the Focus layout ─────────────────────────
//
// The middle of the screen is three things and nothing else: the mark, the
// repository the next question will be asked about, and the space around them.
// The composer below is ChatInput in its focus variant, and the bar above is
// rendered by the page; this file is only what sits between the two.
//
// It is deliberately empty of suggestions and headings. An empty state that
// tells somebody what to ask has answered a question they did not need asked,
// and the repository chip is the one piece of context worth carrying into the
// first message.

/** The mark: two interlocking F-shapes, the larger one behind the smaller. */
function FocusMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 68" className={className} role="img" aria-label="Openmi">
      <rect x="0" y="0" width="13" height="56" fill="#57545f" />
      <rect x="0" y="0" width="44" height="13" fill="#57545f" />
      <rect x="16" y="20" width="12" height="48" fill="#4a4756" />
      <rect x="16" y="20" width="28" height="12" fill="#4a4756" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.8 2.2h8A2 2 0 0 1 20.5 9.7v8.3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6.5 9.5 5.5 5 5.5-5" />
    </svg>
  );
}

export default function FocusHome({
  project,
  onOpenRepo,
}: {
  project: ProjectSummary | null;
  onOpenRepo: () => void;
}) {
  // The chip names the repository the agent would work on, not the owner:
  // `owner/repo` is too long for the chip at this size, and the owner is the
  // part a person already knows.
  const label = project ? project.repoFullName.split("/").pop() || project.repoFullName : "Openmi";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-5 pb-7">
      <div className="text-center">
        <FocusMark className="mx-auto h-11 w-9" />
        <button
          type="button"
          onClick={onOpenRepo}
          className="focus-chip mt-3 inline-flex max-w-[220px] items-center gap-2 rounded-[13px] px-3.5 py-1.5 text-[13px] leading-none text-text-hi transition-colors hover:brightness-110 active:scale-[0.99]"
          aria-label={project ? `Repository: ${project.repoFullName}` : "Choose a repository"}
          title={project ? project.repoFullName : "Choose a repository"}
        >
          <span className="shrink-0 text-text-body">
            <FolderIcon />
          </span>
          <span className="min-w-0 truncate">{label}</span>
          <span className="shrink-0 text-text-mid">
            <ChevronDown />
          </span>
        </button>
      </div>
    </div>
  );
}
