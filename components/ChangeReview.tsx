"use client";

import { useCallback, useEffect, useState } from "react";
import { authHeader } from "@/lib/supabase";
import type { ChangeSetFileView, ChangeSetView, CommitResult } from "@/lib/types";

// ── The change under review ─────────────────────────────────────────────────
//
// Every line here came from the server: the diff is computed from the base
// commit's own bytes, and the file contents that would be committed never leave
// the server at all. That is deliberate — a review screen that rendered text the
// browser supplied could show a comfortable change and commit a different one.
//
// Approve and commit are two calls because they are two decisions, but one
// button, because a person approving a reviewed diff is not making two choices.
// Both endpoints re-check everything themselves; this component cannot grant
// anything, it can only ask.

interface ChangeReviewProps {
  /** The change set stored when the agent proposed it. */
  changesetId: string;
}

interface ApiError extends Error {
  detail?: string | null;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await authHeader()),
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null;
  if (!response.ok) {
    const error = new Error(payload?.error ?? `Request failed (HTTP ${response.status})`) as ApiError;
    error.detail = payload?.detail ?? null;
    throw error;
  }
  return payload as T;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** One line of a unified diff, coloured by what it does. */
function DiffLine({ line }: { line: string }) {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return <span className="text-white/35">{line}</span>;
  }
  if (line.startsWith("@@")) {
    return <span className="text-[#a9d8bb]/60">{line}</span>;
  }
  if (line.startsWith("+")) {
    return <span className="bg-[#7fd1a1]/[0.07] text-[#b6e3c8]">{line}</span>;
  }
  if (line.startsWith("-")) {
    return <span className="bg-red-400/[0.06] text-red-200/75">{line}</span>;
  }
  return <span className="text-white/55">{line}</span>;
}

function FileCard({ file, defaultOpen }: { file: ChangeSetFileView; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.07] bg-black/20">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden="true"
          className={`shrink-0 text-white/30 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/75">{file.path}</span>
        {file.kind === "created" && (
          <span className="shrink-0 rounded bg-[#7fd1a1]/15 px-1.5 py-0.5 text-[8.5px] uppercase tracking-wide text-[#a9d8bb]">
            new
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-[#a9d8bb]/80">+{file.added}</span>
        <span className="shrink-0 font-mono text-[10px] text-red-300/70">−{file.removed}</span>
      </button>
      {open && (
        <pre className="max-h-[340px] overflow-auto border-t border-white/[0.05] px-2 py-1.5 font-mono text-[10.5px] leading-[1.55]">
          {file.diff.split("\n").map((line, index) => (
            <div key={index} className="whitespace-pre">
              <DiffLine line={line} />
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

export default function ChangeReview({ changesetId }: ChangeReviewProps) {
  const [changeSet, setChangeSet] = useState<ChangeSetView | null>(null);
  const [commit, setCommit] = useState<CommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"load" | "approve" | "commit" | null>("load");
  const [dismissed, setDismissed] = useState(false);

  const load = useCallback(async () => {
    setBusy("load");
    setError(null);
    try {
      const data = await api<{ changeSet: ChangeSetView; commit: CommitResult | null }>(
        `/api/changesets/${changesetId}`
      );
      setChangeSet(data.changeSet);
      setCommit(data.commit);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be read.");
    } finally {
      setBusy(null);
    }
  }, [changesetId]);

  useEffect(() => {
    void load();
  }, [load]);

  const approveAndCommit = async () => {
    if (busy || commit) return;
    setError(null);
    try {
      setBusy("approve");
      // The approval is written server-side and bound to this change's hash, so
      // a later edit to the files cannot ride on it.
      await api(`/api/changesets/${changesetId}/approve`, { method: "POST" });
      setBusy("commit");
      const data = await api<{ commit: CommitResult; warning?: string | null }>(
        `/api/changesets/${changesetId}/commit`,
        { method: "POST" }
      );
      setCommit(data.commit);
      setChangeSet((current) => (current ? { ...current, status: "committed" } : current));
      // A branch without a pull request is a real outcome and is reported, not
      // hidden: the commit landed, and saying otherwise would be false.
      if (data.warning) setError(data.warning);
    } catch (cause) {
      const failure = cause as ApiError;
      setError(failure instanceof Error ? failure.message : "The change could not be committed.");
      if (failure?.detail === "stale") {
        setChangeSet((current) => (current ? { ...current, status: "stale" } : current));
      }
    } finally {
      setBusy(null);
    }
  };

  // Dismissing hides the diff, not the change: the proposal is still on the
  // message and still committable, so dropping the card entirely left the
  // reader with nothing to press until they reloaded the page. The way back is
  // one small line in its place.
  if (dismissed) {
    return (
      <button
        type="button"
        onClick={() => setDismissed(false)}
        className="mt-3 flex w-full items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-left text-[11px] text-white/45 transition-colors hover:border-white/[0.14] hover:text-white/80"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h16M4 12h10M4 18h7" />
        </svg>
        {commit ? "Show the committed change" : "Show the proposed change again"}
      </button>
    );
  }

  const added = changeSet?.files.reduce((total, file) => total + file.added, 0) ?? 0;
  const removed = changeSet?.files.reduce((total, file) => total + file.removed, 0) ?? 0;
  const stale = changeSet?.status === "stale";
  const working = busy === "approve" || busy === "commit";

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#2f6b48]/25 text-[#a9d8bb]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6h16M4 12h10M4 18h7" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold text-white/85">
            {changeSet ? `${changeSet.files.length} file${changeSet.files.length === 1 ? "" : "s"} proposed` : "Proposed change"}
          </p>
          <p className="truncate font-mono text-[10px] text-white/35">
            {changeSet ? `${changeSet.repoFullName} · ${changeSet.branch}` : changesetId.slice(0, 10)}
          </p>
        </div>
        {changeSet && (
          <span className="shrink-0 font-mono text-[10px] text-white/45">
            <span className="text-[#a9d8bb]/85">+{added}</span> <span className="text-red-300/70">−{removed}</span>
          </span>
        )}
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] ${
            commit
              ? "bg-[#a9d8bb]/15 text-[#a9d8bb]"
              : stale
                ? "bg-amber-300/15 text-amber-200/80"
                : "bg-white/[0.06] text-white/45"
          }`}
        >
          {commit ? "committed" : stale ? "stale" : changeSet?.status === "approved" ? "approved" : "proposed"}
        </span>
      </div>

      <div className="space-y-1.5 px-2.5 py-2">
        {busy === "load" && !changeSet ? (
          <p className="px-1 py-2 text-[11px] text-white/35">Reading the change…</p>
        ) : changeSet ? (
          changeSet.files.map((file, index) => (
            <FileCard key={file.path} file={file} defaultOpen={index === 0} />
          ))
        ) : null}
      </div>

      {error && (
        <div
          role="alert"
          className="mx-2.5 mb-2 rounded-lg border border-red-400/20 bg-red-500/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-red-200/85"
        >
          {error}
        </div>
      )}

      {commit ? (
        <div className="border-t border-white/[0.06] px-3 py-2 text-[11px] leading-relaxed text-white/55">
          <p>
            Committed as <span className="font-mono text-white/80">{shortSha(commit.sha)}</span> on{" "}
            <span className="font-mono text-white/80">{commit.branch}</span>
            {commit.alreadyCommitted ? " (this change was already committed)" : ""}.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            {commit.prUrl ? (
              <a
                href={commit.prUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[#a9d8bb] underline decoration-[#a9d8bb]/30 underline-offset-2 hover:text-white"
              >
                Open the pull request
              </a>
            ) : (
              <span className="text-white/35">No pull request was opened for this branch.</span>
            )}
            <span className="text-white/30">To undo, revert the pull request — never force-push the branch.</span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2">
          <p className="min-w-0 flex-1 text-[10px] leading-relaxed text-white/30">
            Nothing is written until you approve. Openmi commits to this branch and opens a pull request — never to the
            default branch.
          </p>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={working}
            className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11px] text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={() => void approveAndCommit()}
            disabled={working || !changeSet || stale || changeSet.status === "committed"}
            className="shrink-0 rounded-lg px-3 py-1.5 text-[11.5px] font-semibold text-[#0a100d] transition-opacity disabled:opacity-40"
            style={{ background: "linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 58%, #000) 100%)" }}
          >
            {busy === "approve" ? "Approving…" : busy === "commit" ? "Committing…" : "Approve & commit"}
          </button>
        </div>
      )}
    </div>
  );
}
