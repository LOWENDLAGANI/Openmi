"use client";

// ── The email and password form ──────────────────────────────────────────────
//
// One component, two modes, used by the sign-in screen. It is self-contained on
// purpose — a second copy of these fields would be the kind of duplicate that
// drifts, and the failure modes below are exactly the ones worth fixing in one
// place.
//
// The form never decides who may sign in. It hands a credential to Supabase and
// reports what came back; `describeLinkError` turns the code into a sentence
// with a fix in it. Nothing here can reach the administrator's console.

import { useCallback, useState } from "react";
import {
  emailAuthAvailable,
  refreshVerification,
  registerWithEmail,
  requestPasswordReset,
  resendVerificationEmail,
  signInWithEmail,
} from "@/lib/emailAuth";
import { describeLinkError, type AccountView } from "@/lib/accountState";

interface EmailAuthFormProps {
  /** The name typed into the registration form, carried onto the new account. */
  name?: string;
  /** Called once a session exists and the account is ready to render. */
  onSignedIn?: (view: AccountView) => void;
}

type Mode = "signin" | "register";

export default function EmailAuthForm({ name: initialName, onSignedIn }: EmailAuthFormProps) {
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState(initialName ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifyEmail, setVerifyEmail] = useState<string | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        if (mode === "register") {
          const result = await registerWithEmail(email.trim(), password, name);
          setPassword("");
          if (result.needsVerification) {
            setVerifyEmail(email.trim());
            setNotice(
              "Account created. Check your inbox to confirm the address — the link finishes signing you in."
            );
            return;
          }
          setVerifyEmail(null);
          setNotice("Account created. Welcome to Openmi.");
          if (result.view) onSignedIn?.(result.view);
          return;
        }

        const result = await signInWithEmail(email.trim(), password);
        setPassword("");
        setVerifyEmail(result.needsVerification ? email.trim() : null);
        setNotice("Signed in.");
        if (result.view) onSignedIn?.(result.view);
      } catch (cause) {
        setError(describeLinkError(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy, email, mode, name, onSignedIn, password]
  );

  const reset = useCallback(async () => {
    if (busy) return;
    if (!email.trim()) {
      setError("Enter the address first, then ask for the reset link.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestPasswordReset(email.trim());
      setNotice("If that address has an account, a reset link is on its way. Check your inbox.");
    } catch (cause) {
      setError(describeLinkError(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, email]);

  if (!emailAuthAvailable()) {
    return (
      <p className="rounded-xl border border-amber-300/20 bg-amber-400/[0.05] p-3 text-[11px] leading-relaxed text-amber-100/85">
        This deployment has no Supabase project configured, so an account cannot be created here.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <div className="flex gap-1.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1">
        {(["signin", "register"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setMode(value);
              setError(null);
              setNotice(null);
            }}
            className={`flex-1 rounded-lg px-2 py-2 text-[12px] font-medium transition ${
              mode === value
                ? "bg-white/[0.11] text-white"
                : "text-white/45 hover:bg-white/[0.05] hover:text-white/70"
            }`}
          >
            {value === "signin" ? "Sign in" : "Create account"}
          </button>
        ))}
      </div>

      {mode === "register" && (
        <label className="block">
          <span className="sr-only">Your name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name (optional)"
            autoComplete="name"
            maxLength={40}
            className="w-full rounded-xl border border-white/[0.09] bg-black/30 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
          />
        </label>
      )}

      <label className="block">
        <span className="sr-only">Email address</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          required
          className="w-full rounded-xl border border-white/[0.09] bg-black/30 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
        />
      </label>

      <label className="block">
        <span className="sr-only">Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder={mode === "register" ? "Choose a password (6+ characters)" : "Password"}
          autoComplete={mode === "register" ? "new-password" : "current-password"}
          required
          minLength={6}
          className="w-full rounded-xl border border-white/[0.09] bg-black/30 px-3 py-2.5 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
        />
      </label>

      <button
        type="submit"
        disabled={busy || !email.trim() || !password}
        className="w-full rounded-xl bg-white py-3 text-[13px] font-semibold text-black transition hover:opacity-90 disabled:opacity-40"
      >
        {busy ? "Working…" : mode === "register" ? "Create account" : "Sign in"}
      </button>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void reset()}
          disabled={busy}
          className="text-[10.5px] text-white/35 transition-colors hover:text-white/60 disabled:opacity-50"
        >
          Forgot password?
        </button>
        <span className="text-[10px] text-white/20">Secured by Supabase Auth</span>
      </div>

      {error && <p className="text-[11px] leading-relaxed text-red-200/80">{error}</p>}
      {notice && <p className="text-[11px] leading-relaxed text-[#a9d8bb]/75">{notice}</p>}
      {verifyEmail && <VerificationHint email={verifyEmail} onError={setError} />}
    </form>
  );
}

/**
 * The "confirm your address" line, with a resend.
 *
 * Kept out of the main submit path so a refused resend is reported next to the
 * button that caused it, rather than replacing the fact that the account was
 * created successfully. It also works as a check: pressing it after following
 * the link reports the address as confirmed instead of sending another mail.
 */
function VerificationHint({ email, onError }: { email: string; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"idle" | "sent" | "confirmed">("idle");

  const check = async () => {
    setBusy(true);
    try {
      const { verified } = await refreshVerification();
      if (verified) {
        setState("confirmed");
        return;
      }
      await resendVerificationEmail(email);
      setState("sent");
    } catch (cause) {
      onError(describeLinkError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2">
      <p className="text-[10.5px] leading-relaxed text-white/45">
        {state === "confirmed" ? (
          <span className="text-[#a9d8bb]/85">Address confirmed. Nothing else to do.</span>
        ) : (
          <>
            Confirmation pending for <span className="text-white/70">{email}</span>.
            {state === "sent" ? " A new link is on its way." : ""}
          </>
        )}
      </p>
      {state !== "confirmed" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void check()}
          className="mt-1.5 rounded-md border border-white/[0.12] px-2 py-1 text-[10px] text-white/60 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
        >
          {busy ? "Checking…" : state === "sent" ? "I've confirmed — check again" : "Resend link"}
        </button>
      )}
    </div>
  );
}
