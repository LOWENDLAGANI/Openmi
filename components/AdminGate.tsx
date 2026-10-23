"use client";

import { useCallback, useEffect, useState } from "react";
import { signInAsAdmin, signOutAdmin, verifyAdminAccess } from "@/lib/cloudAdmin";
import { signInWithEmail } from "@/lib/emailAuth";
import { describeLinkError } from "@/lib/accountState";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";

interface AdminGateProps {
  open: boolean;
  onClose: () => void;
  /** Fires once Postgres confirms the signed-in account is the administrator. */
  onUnlocked: () => void;
}

type Mode = "checking" | "signin" | "denied" | "unavailable" | "notconfigured";

/** Turns an auth or database error into something worth reading on a phone. */
function describe(cause: unknown): { code: string; message: string } {
  const error = cause as { code?: string; name?: string } | null;
  const code = error?.code ?? error?.name ?? "unknown";
  const message = cause instanceof Error ? cause.message : String(cause);

  const hints: Record<string, string> = {
    anonymous_provider_disabled:
      "Anonymous sign-ins are switched off. The app signs every first-time visitor in anonymously, so open Supabase → Authentication → Sign In / Providers and turn it on.",
    signup_disabled:
      "This project refuses new accounts. Supabase → Authentication → Sign In / Providers: turn on Allow new users to sign up.",
    email_provider_disabled:
      "Email sign-in is switched off. Supabase → Authentication → Sign In / Providers: turn on Email.",
    provider_disabled:
      "Google sign-in is switched off. Supabase → Authentication → Sign In / Providers: turn on Google, or sign in with the administrator's email and password instead.",
    manual_linking_disabled:
      "This project cannot attach a second sign-in method. Supabase → Authentication → Settings: turn on manual linking.",
    invalid_credentials: "That email and password do not match an account.",
    email_not_confirmed:
      "That address has not been confirmed yet. Follow the link in the inbox, or confirm the user in the dashboard.",
    over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
    "42501":
      "The database refused this account. Check that `app_admin` holds the administrator's address and that the migrations have been applied.",
  };

  return { code, message: hints[code] ?? describeLinkError(cause) ?? message };
}

/**
 * The hidden admin prompt, reached by tapping the logo on the About page ten
 * times.
 *
 * There is no PIN and no address listed in the code. The prompt signs you in and
 * then asks the database whether this account is the administrator —
 * `public.is_admin()` is the same function every policy calls — so the migration
 * stays the single source of truth for who that is.
 */
export default function AdminGate({ open, onClose, onUnlocked }: AdminGateProps) {
  const [mode, setMode] = useState<Mode>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ code: string; message: string } | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Ask the database on every account change, so signing out drops back to the
  // sign-in screen instead of leaving a stale console open.
  useEffect(() => {
    if (!open) return;
    if (!supabaseConfigured) {
      setMode("notconfigured");
      return;
    }
    const client = getSupabase();
    if (!client) {
      setMode("notconfigured");
      return;
    }

    let cancelled = false;

    const fail = (cause: unknown) => {
      if (cancelled) return;
      console.error("[openmi admin]", cause);
      setDetail(describe(cause));
      setMode("unavailable");
    };

    const check = async () => {
      try {
        const allowed = await verifyAdminAccess();
        if (cancelled) return;
        if (allowed) onUnlocked();
        else setMode("signin");
      } catch (cause: unknown) {
        fail(cause);
      }
    };

    void check();
    const { data } = client.auth.onAuthStateChange(() => {
      if (!cancelled) void check();
    });

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [open, onUnlocked]);

  /** Google's door. It leaves the page; the check above runs when it returns. */
  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    setDetail(null);
    try {
      await signInAsAdmin();
    } catch (cause: unknown) {
      console.error("[openmi admin]", cause);
      setDetail(describe(cause));
      setError(describe(cause).message);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * The door that always works: the administrator's own address and password.
   *
   * The address is created once, in the dashboard, and the same one is seeded in
   * `app_admin`. Google is a convenience on top of it, not a requirement — a
   * project with no OAuth client configured still gets in.
   */
  const signInPassword = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      setDetail(null);
      try {
        await signInWithEmail(email, password);
        if (await verifyAdminAccess()) {
          onUnlocked();
          return;
        }
        setMode("denied");
        const client = getSupabase();
        const who = (await client?.auth.getUser())?.data.user?.email ?? null;
        setDetail({
          code: "not-the-admin",
          message: who
            ? `Signed in as ${who}. Seed that address in app_admin (and OPENMI_ADMIN_EMAIL) and try again.`
            : "The database does not list this account as the administrator.",
        });
      } catch (cause: unknown) {
        console.error("[openmi admin] sign-in", cause);
        setDetail(describe(cause));
        setError(describe(cause).message);
      } finally {
        setBusy(false);
      }
    },
    [busy, email, password, onUnlocked]
  );

  const leave = useCallback(async () => {
    setBusy(true);
    try {
      await signOutAdmin();
      setError(null);
      setDetail(null);
      setMode("signin");
    } catch (cause: unknown) {
      setError(describe(cause).message);
    } finally {
      setBusy(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-6">
      <div
        className="absolute inset-0 cursor-default bg-black/75"
        style={{ backdropFilter: "blur(6px)" }}
        aria-hidden
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Openmi administrator sign-in"
        className="relative w-full max-w-sm rounded-t-[28px] border border-white/[0.09] bg-[#141f1a] p-5 shadow-2xl shadow-black/80 animate-rise sm:rounded-[28px]"
      >
        <h2 className="text-[15px] font-semibold text-white">Openmi administrator</h2>

        {mode === "checking" && <p className="mt-2 text-[13px] text-white/50">Checking this browser…</p>}

        {mode === "notconfigured" && (
          <p className="mt-2 text-[13px] text-red-200/80">
            The NEXT_PUBLIC_SUPABASE_* values are missing, so Openmi has no project to talk to. Add them
            to the deployment and redeploy.
          </p>
        )}

        {mode === "unavailable" && (
          <div className="mt-2 space-y-2 text-[13px] text-white/60">
            <p>Openmi could not reach the database, so the console cannot be opened.</p>
            {detail && (
              <p className="break-words rounded-lg bg-black/40 px-2 py-2 font-mono text-[11px] leading-relaxed text-white/75">
                {detail.code}
                {detail.message ? ` — ${detail.message}` : ""}
              </p>
            )}
          </div>
        )}

        {mode === "signin" && (
          <div className="mt-2 space-y-2 text-[13px] text-white/60">
            <p>Sign in with the administrator&rsquo;s account.</p>
            <form onSubmit={signInPassword} className="space-y-2">
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@example.com"
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
              />
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
              />
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-xl bg-[#2a6142] py-2.5 text-[13px] font-medium text-white transition hover:bg-[#327350] disabled:opacity-50"
              >
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </form>
            <div className="flex items-center gap-2 py-1">
              <span className="h-px flex-1 bg-white/10" />
              <span className="text-[10px] uppercase tracking-wide text-white/25">or</span>
              <span className="h-px flex-1 bg-white/10" />
            </div>
            <button
              type="button"
              onClick={signIn}
              disabled={busy}
              className="w-full rounded-xl bg-white/[0.08] py-2.5 text-[13px] font-medium text-white transition hover:bg-white/[0.12] disabled:opacity-50"
            >
              {busy ? "Opening Google…" : "Continue with Google"}
            </button>
            {error && <p className="text-[12px] text-red-200/80">{error}</p>}
          </div>
        )}

        {mode === "denied" && (
          <div className="mt-2 space-y-2 text-[13px] text-white/60">
            <p>That account is signed in, but the database does not list it as the administrator.</p>
            <p className="text-[12px] text-white/45">
              The administrator is the address in the `app_admin` row, and OPENMI_ADMIN_EMAIL must name the
              same person.
            </p>
            <button
              type="button"
              onClick={() => void leave()}
              disabled={busy}
              className="w-full rounded-xl border border-white/[0.09] py-2 text-[13px] text-white/70 transition hover:bg-white/[0.06] disabled:opacity-50"
            >
              {busy ? "Signing out…" : "Use another account"}
            </button>
            {detail && <p className="break-all text-[12px] text-red-200/80">{detail.message}</p>}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-xl border border-white/[0.09] py-2 text-[13px] text-white/70 transition hover:bg-white/[0.06]"
        >
          Cancel
        </button>
      </section>
    </div>
  );
}
