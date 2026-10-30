"use client";

import type { Appearance, HomeLayout, ReasoningEffort, ResponseLength } from "@/lib/settings";
import type { SearchMode } from "@/lib/types";
import { useEffect } from "react";
import AccountSection from "@/components/AccountSection";
import ApiKeysSection from "@/components/ApiKeysSection";
import DataControls from "@/components/DataControls";
interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  displayName: string;
  onDisplayNameChange: (name: string) => void;
  avatarUrl?: string;
  onAvatarChange?: (avatarUrl: string) => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  searchAvailable: boolean;
  responseLength: ResponseLength;
  onResponseLengthChange: (value: ResponseLength) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (value: ReasoningEffort) => void;
  appearance: Appearance;
  onAppearanceChange: (value: Appearance) => void;
  homeLayout: HomeLayout;
  onHomeLayoutChange: (value: HomeLayout) => void;
}

const HOME_OPTIONS: Array<{ id: HomeLayout; label: string; description: string; preview: React.ReactNode }> = [
  {
    id: "classic",
    label: "Classic",
    description: "Headline over the composer",
    preview: (
      <svg width="44" height="28" viewBox="0 0 44 28" fill="none" aria-hidden="true">
        <rect x="6" y="5" width="32" height="3" rx="1.5" fill="currentColor" opacity="0.75" />
        <rect x="11" y="11" width="22" height="2.5" rx="1.25" fill="currentColor" opacity="0.35" />
        <rect x="4" y="19" width="36" height="6" rx="3" fill="currentColor" opacity="0.2" />
      </svg>
    ),
  },
  {
    id: "focus",
    label: "Focus · ink",
    description: "Mark, repository, composer",
    preview: (
      <svg width="44" height="28" viewBox="0 0 44 28" fill="none" aria-hidden="true">
        <path d="M18 4h2.6v10H18zM18 4h7v2.6h-7zM21.5 8.5h2.6v9.5h-2.6zM21.5 8.5h6v2.6h-6z" fill="currentColor" opacity="0.8" />
        <rect x="14" y="21" width="16" height="3.5" rx="1.75" fill="currentColor" opacity="0.3" />
      </svg>
    ),
  },
];

const SEARCH_OPTIONS: Array<{ id: SearchMode; label: string; description: string; icon: React.ReactNode }> = [
  { 
    id: "auto", 
    label: "Auto", 
    description: "Smart search when needed",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
    </svg>
  },
  { 
    id: "always", 
    label: "On", 
    description: "Search every message",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
    </svg>
  },
  { 
    id: "off", 
    label: "Off", 
    description: "Never search",
    icon: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
    </svg>
  },
];

const LENGTH_OPTIONS: Array<{ id: ResponseLength; label: string; description: string }> = [
  { id: "short", label: "Short", description: "Lead with the answer" },
  { id: "balanced", label: "Balanced", description: "Default amount of detail" },
  { id: "detailed", label: "Detailed", description: "Thorough with examples" },
];

const EFFORT_OPTIONS: Array<{ id: ReasoningEffort; label: string; description: string; icon: React.ReactNode }> = [
  { 
    id: "low", 
    label: "Low", 
    description: "Fastest, cheapest",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  },
  { 
    id: "medium", 
    label: "Medium", 
    description: "Thinks a little harder",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  },
  { 
    id: "high", 
    label: "High", 
    description: "Slowest, most careful",
    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  },
];

export default function SettingsPanel({
  open,
  onClose,
  displayName,
  onDisplayNameChange,
  avatarUrl,
  onAvatarChange,
  searchMode,
  onSearchModeChange,
  searchAvailable,
  responseLength,
  onResponseLengthChange,
  reasoningEffort,
  onReasoningEffortChange,
  appearance,
  onAppearanceChange,
  homeLayout,
  onHomeLayoutChange,
}: SettingsPanelProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div
        className="absolute inset-0 bg-black/70 animate-fade"
        style={{ backdropFilter: "blur(8px)" }}
        onClick={onClose}
        aria-hidden
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="Openmi settings"
        className="relative flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-[28px] border border-white/[0.09] bg-[#141f1a] shadow-2xl shadow-black/80 animate-view-in sm:rounded-[28px]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
          <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-white">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white"
            aria-label="Close settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 stagger-children">
          <AccountSection displayName={displayName} onDisplayNameChange={onDisplayNameChange} avatarUrl={avatarUrl} onAvatarChange={onAvatarChange} />
          <div className="grid grid-cols-1 gap-4" style={{ ['--stagger' as string]: 3 }}>
            <section className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 card-hover animate-enter" style={{ ['--stagger' as string]: 4 }}>
              <h3 className="mb-3 flex items-center gap-1.5 text-[14px] font-semibold text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[#a9d8bb]" aria-hidden="true">
                  <circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
                Appearance
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {(["dark", "light"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => onAppearanceChange(value)}
                    className={`flex flex-col items-center gap-2 rounded-lg py-3 px-4 transition-all duration-200 ${appearance === value ? "bg-white/[0.1] text-white ring-1 ring-white/20" : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"}`}
                  >
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${appearance === value ? "bg-white/10" : "bg-white/[0.03]"}`}>
                      {value === "dark" ? (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-[#a9d8bb]" aria-hidden="true">
                          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="text-[#fcd34d]" aria-hidden="true">
                          <circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                        </svg>
                      )}
                    </div>
                    <span className="text-[13px] font-medium capitalize">{value}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 card-hover animate-enter" style={{ ['--stagger' as string]: 5 }}>
              <h3 className="mb-1 flex items-center gap-1.5 text-[14px] font-semibold text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[#a9d8bb]" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 10h18" />
                </svg>
                Home layout
              </h3>
              <p className="mb-3 text-[11px] leading-relaxed text-white/40">
                Focus is the mobile home screen, and it brings its own ink-indigo palette.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {HOME_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onHomeLayoutChange(option.id)}
                    className={`flex flex-col items-center gap-1 rounded-lg px-3 py-3 transition-all duration-200 ${homeLayout === option.id ? "bg-white/[0.1] text-white ring-1 ring-white/20" : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"}`}
                  >
                    <span className={homeLayout === option.id ? "text-[#a9d8bb]" : "text-white/40"}>{option.preview}</span>
                    <span className="text-[13px] font-medium">{option.label}</span>
                    <span className="text-[10px] leading-tight text-white/30">{option.description}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 card-hover animate-enter" style={{ ['--stagger' as string]: 6 }}>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-[14px] font-semibold text-white">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[#a9d8bb]" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                  </svg>
                  Web search
                  {!searchAvailable && (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-300/80" title="No search key in the deployment environment" />
                  )}
                </h3>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {SEARCH_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={!searchAvailable}
                    onClick={() => onSearchModeChange(option.id)}
                    className={`flex flex-col items-center gap-1.5 rounded-lg py-3 px-2 transition-all duration-200 ${searchMode === option.id ? "bg-white/[0.1] text-white ring-1 ring-white/20" : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    <span className="text-xl">{option.icon}</span>
                    <span className="text-[13px] font-medium">{option.label}</span>
                    <span className="text-[10px] text-white/30">{option.description}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 card-hover animate-enter" style={{ ['--stagger' as string]: 7 }}>
              <h3 className="mb-3 flex items-center gap-1.5 text-[14px] font-semibold text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[#a9d8bb]" aria-hidden="true">
                  <path d="M11 4h10M11 4l3 3M11 4v16" />
                </svg>
                Response length
              </h3>
              <div className="space-y-2">
                {LENGTH_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onResponseLengthChange(option.id)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-all duration-200 ${responseLength === option.id ? "border-[#a9d8bb]/30 bg-[#a9d8bb]/[0.08]" : "border-white/[0.06] hover:bg-white/[0.04]"}`}
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${responseLength === option.id ? "border-[#a9d8bb]" : "border-white/25"}`}>
                      {responseLength === option.id && <span className="h-2 w-2 rounded-full bg-[#a9d8bb]" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-white/90">{option.label}</span>
                      <span className="mt-0.5 block text-[11px] text-white/40">{option.description}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-xl bg-white/[0.03] border border-white/[0.06] p-4 card-hover animate-enter" style={{ ['--stagger' as string]: 8 }}>
              <h3 className="mb-3 flex items-center gap-1.5 text-[14px] font-semibold text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-[#a9d8bb]" aria-hidden="true">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                Reasoning effort
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {EFFORT_OPTIONS.map((option) => {
                  const isPro = option.id !== "low";
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onReasoningEffortChange(option.id)}
                      className={`flex flex-col items-center gap-1.5 rounded-lg py-3 px-2 transition-all duration-200 ${reasoningEffort === option.id ? "bg-white/[0.1] text-white ring-1 ring-white/20" : "text-white/45 hover:bg-white/[0.05] hover:text-white/75"}`}
                    >
                      <span className="text-lg">{option.icon}</span>
                      <span className="text-[13px] font-medium">{option.label}</span>
                      <span className="text-[10px] text-white/30">
                        {isPro ? "Pro tier" : option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

          </div>

          <ApiKeysSection />

          <DataControls />

        </div>
      </section>
    </div>
  );
}

