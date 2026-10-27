"use client";

// ── The sign-in screen ───────────────────────────────────────────────────────
//
// Openmi has no guest mode: this screen is the whole interface until a session
// exists. It offers the four doors the deployment supports — Google, GitHub,
// Microsoft and an email address with a password — and the same buttons register
// a first-time account, because Supabase creates the user when the provider
// returns one it has not seen.
//
// It is deliberately one screen rather than a name prompt followed by settings:
// the name now comes from the account (or from the registration form), and every
// chat, preference and connection belongs to that account from the first click.

import { useCallback, useState } from "react";
import OpenmiMark from "./OpenmiMark";
import EmailAuthForm from "./EmailAuthForm";
import { signInWithProvider, type OAuthProvider } from "@/lib/account";
import { describeLinkError, isDismissed } from "@/lib/accountState";
import { supabaseConfigured } from "@/lib/supabase";

interface AuthScreenProps {
  /** A failure the last page load carried back from a provider. */
  initialError?: string | null;
  /** Why sign-in cannot be offered, when it cannot. */
  unavailable?: "unconfigured" | "unreachable" | null;
}

const PROVIDERS: Array<{
  id: OAuthProvider;
  label: string;
  icon: React.ReactNode;
}> = [
  {
    id: "google",
    label: "Continue with Google",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="#EA4335"
          d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1a6.2 6.2 0 0 1 0-12.4c1.76 0 2.94.75 3.62 1.4l2.57-2.47A9.9 9.9 0 0 0 12 2.5a9.5 9.5 0 1 0 0 19c5.5 0 9.13-3.86 9.13-9.3 0-.62-.07-1.1-.15-1.6z"
        />
      </svg>
    ),
  },
  {
    id: "github",
    label: "Continue with GitHub",
    icon: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 .5A11.5 11.5 0 0 0 .5 12.3c0 5.2 3.3 9.6 7.9 11.2.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.6-3.9-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.3 1.8 1.3 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.2 11.2 0 0 1 6 0C17.5 5.6 18.5 6 18.5 6c.6 1.6.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.7 5.6-5.3 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.6 7.9-6 7.9-11.2A11.5 11.5 0 0 0 12 .5z" />
      </svg>
    ),
  },
  {
    id: "microsoft",
    label: "Continue with Microsoft",
    icon: (
      <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden>
        <path fill="#F25022" d="M1 1h10v10H1z" />
        <path fill="#7FBA00" d="M12 1h10v10H12z" />
        <path fill="#00A4EF" d="M1 12h10v10H1z" />
        <path fill="#FFB900" d="M12 12h10v10H12z" />
      </svg>
    ),
  },
];

export default function AuthScreen({ initialError = null, unavailable = null }: AuthScreenProps) {
  const [busy, setBusy] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(initialError);

  const start = useCallback(
    async (provider: OAuthProvider) => {
      if (busy) return;
      setBusy(provider);
      setError(null);
      try {
        await signInWithProvider(provider);
      } catch (cause) {
        if (!isDismissed(cause)) setError(describeLinkError(cause));
      } finally {
        // The browser usually navigates away before this resolves. When the
        // provider refuses, the button has to become usable again.
        setBusy(null);
      }
    },
    [busy]
  );

  const canSignIn = supabaseConfigured && unavailable !== "unconfigured";

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#060a08] px-5 py-10 text-white">
      <div className="w-full max-w-[420px]">
        <div className="flex flex-col items-center text-center">
          <OpenmiMark className="h-11 w-11" />
          <h1 className="mt-4 text-[24px] font-semibold tracking-[-0.03em]">
            Sign in to Openmi
          </h1>
          <p className="mt-2 max-w-[320px] text-[12.5px] leading-relaxed text-white/45">
            An account keeps your chats, preferences and repository connections with you on every
            browser.
          </p>
        </div>

        {unavailable && (
          <div
            role="status"
            className="mt-6 rounded-[16px] border border-amber-300/20 bg-amber-400/[0.05] px-3.5 py-3 text-[11.5px] leading-relaxed text-amber-100/85"
          >
            {unavailable === "unconfigured"
              ? "This deployment has no Supabase project configured, so accounts cannot be used yet. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY and rebuild."
              : "Openmi cannot reach the account service right now. Your local data is safe — check the connection and reload."}
          </div>
        )}

        {canSignIn && (
          <div className="mt-7 space-y-2">
            {PROVIDERS.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => void start(provider.id)}
                disabled={busy !== null}
                className="flex w-full items-center justify-center gap-2.5 rounded-[14px] border border-white/[0.09] bg-white/[0.04] py-3 text-[13px] font-medium text-white transition hover:bg-white/[0.08] disabled:opacity-50"
              >
                {provider.icon}
                {busy === provider.id ? "Opening…" : provider.label}
              </button>
            ))}
          </div>
        )}

        {canSignIn && (
          <div className="my-6 flex items-center gap-3" aria-hidden>
            <span className="h-px flex-1 bg-white/[0.08]" />
            <span className="text-[10px] uppercase tracking-[0.14em] text-white/25">or</span>
            <span className="h-px flex-1 bg-white/[0.08]" />
          </div>
        )}

        {canSignIn && <EmailAuthForm />}

        {error && (
          <p role="alert" className="mt-4 rounded-xl border border-red-400/20 bg-red-500/[0.06] px-3 py-2.5 text-[11.5px] leading-relaxed text-red-200/85">
            {error}
          </p>
        )}

        <p className="mt-6 text-center text-[10.5px] leading-relaxed text-white/25">
          New here? The provider buttons create your account. Your data is stored in this
          project&apos;s Supabase database and only your account can read it.
        </p>
      </div>
    </div>
  );
}
