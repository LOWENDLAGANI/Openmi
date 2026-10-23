"use client";

import { useCallback, useEffect, useState } from "react";
import { watchAccount } from "@/lib/account";
import { signOutToGuest } from "@/lib/emailAuth";
import {
  accountExplanation,
  accountHeadline,
  describeLinkError,
  type AccountView,
} from "@/lib/accountState";
import { loadChatsFromAccount, syncFirebaseHistory } from "@/lib/firebaseHistory";
import EmailAuthForm from "./EmailAuthForm";
import AuthDiagnostics from "./AuthDiagnostics";

interface AccountSectionProps {
  displayName: string;
}

/**
 * The account row in Settings: what this browser is signed in as, and the form
 * that changes it.
 *
 * This is the whole of the visitor's sign-in. It is kept away from the
 * administrator's prompt on purpose — that one is reached by tapping the logo ten
 * times, and the two share nothing but the Firebase project. Signing in here
 * grants a token; only `database.rules.json` decides what a token is worth, and
 * it grants one named address and no others.
 *
 * The credential is an email address and a password, held by Firebase Auth.
 * Registering upgrades the anonymous account this browser already has, so the
 * uid — and every chat written under it — stays exactly where it is. Nothing is
 * required: someone who never registers still has a name, a working Openmi, and
 * a chat history in their browser.
 */
export default function AccountSection({ displayName }: AccountSectionProps) {
  const [view, setView] = useState<AccountView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => watchAccount(setView), []);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  /**
   * Brings the account's chats in, then writes this device's own back out.
   *
   * The order matters and is the whole point. Pulling first means a computer
   * that signs in to an account holding a phone's history adopts it instead of
   * uploading an empty library over the top of it; pushing afterwards means this
   * device's chats exist on the account too. Doing it here rather than inside
   * the auth module keeps that module free of chat logic and means a failed sync
   * never blocks the sign-in itself.
   */
  const resync = useCallback(async (announce: boolean) => {
    try {
      const adopted = await loadChatsFromAccount();
      await syncFirebaseHistory();
      if (announce && adopted && adopted.chats > 0) {
        setNotice(
          `Pulled ${adopted.chats} chat${adopted.chats === 1 ? "" : "s"} from your account.`
        );
      }
    } catch (cause: unknown) {
      console.error("[Openmi] Could not sync this device's chats with the account", cause);
    }
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await signOutToGuest();
      setNotice("This device is back to a name on its own. Your account is untouched.");
    } catch (cause) {
      console.error("[Openmi] Could not sign out", cause);
      setError(describeLinkError(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!view || view.status === "unconfigured" || view.status === "unreachable") return null;

  const linked = view.isLinked;

  return (
    <section>
      <h3 className="mb-2.5 text-[13px] font-semibold text-white">Account</h3>

      <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-white/60"
          >
            {linked ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
              </svg>
            )}
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-white/90">
              {accountHeadline(view, displayName)}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-white/40">
              {accountExplanation(view)}
            </p>
            {linked && view.provider === "email" && !view.emailVerified && (
              <p className="mt-1 text-[10.5px] leading-relaxed text-amber-100/60">
                Email not confirmed yet. Nothing is blocked — confirm it whenever the link arrives.
              </p>
            )}
          </div>
        </div>

        {!linked && (
          <div className="mt-3">
            <EmailAuthForm
              name={displayName}
              onSignedIn={(_next, outcome) => {
                // An upgraded guest keeps its uid and only needs the push half;
                // an adopted account brought its history with it and needs the
                // pull too. Both are safe to run, so the difference is only what
                // is said about it.
                void resync(outcome === "adopted");
                setError(null);
              }}
            />
          </div>
        )}

        {linked && (
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={busy}
            className="mt-3 w-full rounded-xl border border-white/[0.09] py-2.5 text-[13px] font-medium text-white/70 transition hover:bg-white/[0.06] disabled:opacity-50"
          >
            {busy ? "Working…" : "Use this device without an account"}
          </button>
        )}

        {error && <p className="mt-2.5 text-[11px] leading-relaxed text-red-200/80">{error}</p>}
        {notice && <p className="mt-2.5 text-[11px] leading-relaxed text-[#a9d8bb]/70">{notice}</p>}
      </div>

      {/* Collapsed by default: it is a diagnostic, not part of the account row. */}
      <AuthDiagnostics />
    </section>
  );
}
