"use client";

import Spinner from "./Spinner";

// ── Set a new password ───────────────────────────────────────────────────────
//
// Supabase's recovery mail returns here through the PKCE flow, which signs the
// person in. This screen is what turns that session into an actual password
// change: without it, following a reset link only logs you in and leaves the old
// password working, which is the halfway state people report as "the reset did
// nothing".
//
// It is deliberately a standalone route rather than a modal over the product.
// The redirect target itself carries the intent, so the screen appears even when
// the auth event order changes (Supabase's own docs warn that SIGNED_IN and
// PASSWORD_RECOVERY are not guaranteed to arrive in a particular order).
//
// The session is not signed out afterwards. The link already proved control of
// the address, Supabase rotates the session on a password change, and dropping
// the person back on the sign-in screen would make them type the password twice.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import OpenmiMark from "./OpenmiMark";
import { changePassword } from "@/lib/emailAuth";
import { describeLinkError } from "@/lib/accountState";
import { passwordProblem } from "@/lib/passwordRecovery";
import { currentUser, getSupabase, supabaseConfigured } from "@/lib/supabase";

type Status = "checking" | "ready" | "saving" | "done" | "expired" | "unconfigured";

/** How long to wait for the recovery session before calling the link stale. */
const SESSION_WAIT_MS = 10_000;

export default function PasswordRecoveryScreen() {
  const [status, setStatus] = useState<Status>(() =>
    supabaseConfigured ? "checking" : "unconfigured"
  );
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The Supabase client exchanges the `code` in the URL for a session on its
  // first auth call. Both the one-shot read and the subscription are used: the
  // read covers a fast exchange, the subscription covers one that finishes a
  // moment later, and whichever answers first opens the form.
  useEffect(() => {
    if (!supabaseConfigured) return;
    const client = getSupabase();
    if (!client) {
      setStatus("unconfigured");
      return;
    }

    let settled = false;
    const ready = (address: string | null) => {
      if (settled) return;
      settled = true;
      setEmail(address);
      setStatus("ready");
    };

    void currentUser()
      .then((user) => {
        if (user) ready(user.email ?? null);
      })
      .catch(() => {
        // The timeout below decides what to show.
      });

    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user) ready(session.user.email ?? null);
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        setStatus("expired");
      }
    }, SESSION_WAIT_MS);

    return () => {
      settled = true;
      clearTimeout(timer);
      data.subscription.unsubscribe();
    };
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (status !== "ready") return;
      const problem = passwordProblem(password, confirmation);
      if (problem) {
        setError(problem);
        return;
      }

      setStatus("saving");
      setError(null);
      try {
        await changePassword(password);
        setPassword("");
        setConfirmation("");
        setStatus("done");
      } catch (cause) {
        setError(describeLinkError(cause));
        setStatus("ready");
      }
    },
    [confirmation, password, status]
  );

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#060a08] px-5 py-10 text-white">
      <div className="w-full max-w-[420px]">
        <div className="flex flex-col items-center text-center">
          <OpenmiMark className="h-11 w-11" />
          <h1 className="mt-4 text-[24px] font-semibold tracking-[-0.03em]">
            Set a new password
          </h1>
          <p className="mt-2 max-w-[330px] text-[12.5px] leading-relaxed text-white/45">
            {status === "done"
              ? "Your password has been changed. The account is ready to use."
              : "Choose a password for your Openmi account. The reset link has already signed this browser in."}
          </p>
        </div>

        {status === "unconfigured" && (
          <Banner>
            This deployment has no Supabase project configured, so a password cannot be changed
            here.
          </Banner>
        )}

        {status === "checking" && (
          <p className="mt-7 text-center text-[12px] text-white/35">Checking the reset link…</p>
        )}

        {status === "expired" && (
          <div className="mt-7 space-y-3">
            <Banner>
              This reset link has expired or was already used. Request a new one from the sign-in
              screen, and open it in the same browser you asked from — Supabase&apos;s secure flow
              ties the link to that browser.
            </Banner>
            <Link
              href="/chat"
              className="block w-full rounded-xl bg-white py-3 text-center text-[13px] font-semibold text-black transition hover:opacity-90"
            >
              Back to sign in
            </Link>
          </div>
        )}

        {(status === "ready" || status === "saving" || status === "done") && (
          <div className="mt-7">
            {email && (
              <p className="mb-3 text-center text-[11.5px] text-white/35">
                for <span className="text-white/65">{email}</span>
              </p>
            )}

            {status === "done" ? (
              <Link
                href="/chat"
                className="block w-full rounded-xl bg-white py-3 text-center text-[13px] font-semibold text-black transition hover:opacity-90"
              >
                Continue to Openmi
              </Link>
            ) : (
              <form onSubmit={submit} className="space-y-2.5">
                <label className="block">
                  <span className="sr-only">New password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="New password (6+ characters)"
                    autoComplete="new-password"
                    minLength={6}
                    required
                    autoFocus
                    className="w-full rounded-xl border border-white/[0.09] bg-black/30 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                  />
                </label>

                <label className="block">
                  <span className="sr-only">Confirm new password</span>
                  <input
                    type="password"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    placeholder="Confirm the new password"
                    autoComplete="new-password"
                    minLength={6}
                    required
                    className="w-full rounded-xl border border-white/[0.09] bg-black/30 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                  />
                </label>

                <button
                  type="submit"
                  disabled={status === "saving" || !password || !confirmation}
                  className="w-full rounded-xl bg-white py-3 text-[13px] font-semibold text-black transition hover:opacity-90 disabled:opacity-40"
                >
                  <span className="inline-flex items-center justify-center gap-2">
                    {status === "saving" && <Spinner size={13} />}
                    {status === "saving" ? "Saving…" : "Save new password"}
                  </span>
                </button>

                {error && (
                  <p role="alert" className="text-[11px] leading-relaxed text-red-200/80">
                    {error}
                  </p>
                )}
              </form>
            )}


          </div>
        )}
      </div>
    </main>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="mt-6 rounded-[14px] border border-amber-300/20 bg-amber-400/[0.05] px-3.5 py-3 text-[11.5px] leading-relaxed text-amber-100/85"
    >
      {children}
    </p>
  );
}
