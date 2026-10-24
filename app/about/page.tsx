import Link from "next/link";
import AboutLogo from "@/components/AboutLogo";
import MaintenanceGate from "@/components/MaintenanceGate";
import SetupStatus from "@/components/SetupStatus";

// ── Fill these in ────────────────────────────────────────────────────────────
/** When the first Openmi build was created. */
const DATE_CREATED = "24/9/2026";

/** Milestones reached, oldest first. Titles only — the point is the trail.
    Kept in step with the commits: every bullet is work that landed. */
const PROGRESS: Array<{ label: string; state: "done" | "active" | "next" }> = [
  { label: "Instant chat", state: "done" },
  { label: "Streaming responses", state: "done" },
  { label: "Auto and Code modes", state: "done" },
  { label: "Resilient provider fallback", state: "done" },
  { label: "Web search", state: "done" },
  { label: "Camera and file attachments", state: "done" },
  { label: "Account history sync", state: "done" },
  { label: "Settings panel", state: "done" },
  { label: "Admin console", state: "done" },
  { label: "Visitor names", state: "done" },
  { label: "Reasoning effort", state: "done" },
  { label: "Redeem codes the owner writes and terminates", state: "done" },
  { label: "Temporary chats that are never written down", state: "done" },
  { label: "Branching replies, folders, and message search", state: "done" },
  { label: "Bans with a reason, a length, and a record", state: "done" },
  { label: "Trash with a thirty-day restore", state: "done" },
  { label: "One flat Dew price per model", state: "done" },
  { label: "GitHub authorisation and repository reading", state: "active" },
  { label: "Proposed changes with a review step", state: "next" },
  { label: "Commits you approve, on an agent branch", state: "next" },
];

const STATE_STYLES = {
  done: {
    label: "Shipped",
    chip: "bg-emerald-400/10 text-emerald-300/90",
    ring: "text-emerald-300/70",
    arrow: "text-emerald-300/70",
  },
  active: {
    label: "In progress",
    chip: "bg-[#a9d8bb]/10 text-[#a9d8bb]",
    ring: "text-[#a9d8bb] shadow-[0_0_14px_-2px_rgba(169,216,187,0.5)]",
    arrow: "text-[#a9d8bb]",
  },
  next: {
    label: "Planned",
    chip: "bg-white/[0.06] text-white/45",
    ring: "text-white/25",
    arrow: "text-white/25",
  },
} as const;

export const metadata = {
  title: "About — Openmi",
  description: "Openmi is a private AI assistant created and developed by Minetallest.",
};

export default function AboutPage() {
  return (
    <MaintenanceGate>
      <AboutContent />
    </MaintenanceGate>
  );
}

/** The page itself, kept separate so the gate can wrap it wholesale. */
function AboutContent() {
  return (
    <div className="app-surface flex min-h-[100dvh] flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-xl px-6 py-10 sm:px-8 sm:py-14">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[12px] text-white/45 transition-colors hover:text-white/80"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Back to chat
        </Link>

        <header className="mt-12 flex flex-col items-center text-center">
          <div className="relative flex h-28 w-28 items-center justify-center sm:h-36 sm:w-36">
            <div className="absolute inset-[-40%] rounded-full bg-[#2f6b48]/15 blur-3xl" />
            <AboutLogo className="relative h-full w-full" />
          </div>
          <h1 className="mt-8 text-balance text-[38px] font-normal leading-[1.05] tracking-[-0.03em] text-white sm:text-[52px]">
            Openmi
          </h1>
          <p className="mt-3 max-w-sm text-balance text-[13px] leading-relaxed text-white/40 sm:text-[14px]">
            Openmi is still in beta testing. Stay tuned, and thank you for your patience.
          </p>
        </header>

        {/* What this deployment has not configured yet. Owned by the owner:
            it reads a public presence report and shows only the gaps. */}
        <SetupStatus />

        <section className="mt-14 grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">Created by</div>
            <p className="mt-1.5 text-[18px] font-semibold tracking-[-0.01em] text-white">Minetallest</p>
            <p className="mt-1 text-[12px] leading-relaxed text-white/40">
              Sole creator, designer, and developer of Openmi.
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">Date created</div>
            <p className="mt-1.5 text-[18px] font-semibold tracking-[-0.01em] text-white">{DATE_CREATED}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-white/40">
              When the first build of Openmi went live.
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] p-5 sm:col-span-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">AI name</div>
            <p className="mt-1.5 text-[18px] font-semibold tracking-[-0.01em] text-white">Openmi</p>
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-5 flex items-baseline justify-between gap-4">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">Progress</h2>
            <span className="text-[11px] text-white/25">
              {PROGRESS.filter((item) => item.state === "done").length} shipped
            </span>
          </div>
          <ol className="relative">
            <span className="absolute bottom-4 left-[13px] top-4 w-px bg-white/[0.06]" aria-hidden />
            {PROGRESS.map((item) => {
              const style = STATE_STYLES[item.state];
              return (
                <li key={item.label} className="relative flex items-center gap-3 py-2">
                  <span
                    className={`relative z-10 flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-full border border-white/[0.07] bg-[#0b1312] ${style.ring}`}
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={style.arrow}
                      aria-hidden
                    >
                      <path d="M5 12h13M13 6l6 6-6 6" />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1 text-[13.5px] font-medium text-white/85">{item.label}</span>
                  {item.state !== "done" && (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] ${style.chip}`}
                    >
                      {style.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <footer className="mt-14 border-t border-white/[0.06] pt-6 text-center">
          <p className="text-[12px] text-white/30">
            Openmi · created by <span className="text-white/55">Minetallest</span>
          </p>
          <Link
            href="/"
            className="mt-4 inline-flex items-center justify-center rounded-full bg-white px-5 py-2.5 text-[12px] font-semibold text-black transition-opacity hover:opacity-90"
          >
            Open Openmi
          </Link>
        </footer>
      </div>
    </div>
  );
}
