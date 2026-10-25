"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signOutAccount, watchAccount } from "@/lib/account";
import { changePassword } from "@/lib/emailAuth";
import {
  accountExplanation,
  accountHeadline,
  describeLinkError,
  providerLabel,
  type AccountView,
} from "@/lib/accountState";
import { compressFiles } from "@/lib/imageUtils";
import { nameInitial } from "@/lib/visitorName";
import AuthDiagnostics from "./AuthDiagnostics";

interface AccountSectionProps {
  displayName: string;
  /** Saves the name here, in `profiles`, in the account preferences and metadata. */
  onDisplayNameChange: (name: string) => void;
  avatarUrl?: string;
  onAvatarChange?: (avatarUrl: string) => void;
}

/**
 * The account row in Settings: what this browser is signed in as, the name the
 * product greets you by, and the way out.
 *
 * This is kept away from the administrator's prompt on purpose — that one is
 * reached by tapping the logo ten times, and the two share nothing but the
 * Supabase project. Signing in here grants a token; only row-level security
 * decides what a token is worth, and it grants one verified admin and no others.
 */
export default function AccountSection({ displayName, onDisplayNameChange, avatarUrl, onAvatarChange }: AccountSectionProps) {
  const [view, setView] = useState<AccountView | null>(null);
  const [name, setName] = useState(displayName);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => watchAccount(setView), []);

  useEffect(() => {
    setName(displayName);
  }, [displayName]);

  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const saveName = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A name needs at least one character.");
      return;
    }
    setError(null);
    onDisplayNameChange(trimmed);
    setNotice("Name saved to this account.");
  }, [name, onDisplayNameChange]);

  const handleAvatarUpload = useCallback(
    async (file: File) => {
      if (!onAvatarChange) return;
      setUploading(true);
      setError(null);
      try {
        const { results, errors } = await compressFiles([file]);
        if (errors.length || results.length === 0) {
          setError(errors[0] || "Could not process image.");
          return;
        }
        const dataUrl = results[0].dataUrl;
        if (dataUrl.length > 500000) {
          setError("Image is too large. Try a smaller image.");
          return;
        }
        onAvatarChange(dataUrl);
        setNotice("Profile picture updated.");
      } catch {
        setError("Failed to upload image.");
      } finally {
        setUploading(false);
      }
    },
    [onAvatarChange]
  );

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await signOutAccount();
    } catch (cause) {
      console.error("[Openmi] Could not sign out", cause);
      setError(describeLinkError(cause));
      setBusy(false);
    }
  }, []);

  // Waiting on the first read: nothing to say yet, and a blank row is better
  // than one that arrives a frame later.
  if (!view) return null;

  const unconfigured = view.status === "unconfigured";
  const unreachable = view.status === "unreachable";
  const signedIn = view.status === "signed-in";

  return (
    <section>
      <h3 className="mb-2.5 text-[13px] font-semibold text-white">Account</h3>

      <div
        className={`rounded-[16px] border px-3.5 py-3 ${
          unconfigured || unreachable
            ? "border-amber-300/20 bg-amber-400/[0.05]"
            : "border-white/[0.06] bg-white/[0.02]"
        }`}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-white/60"
          >
            {signedIn ? (
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
            {signedIn && (
              <p className="mt-1 text-[10.5px] text-white/30">
                Signed in with {providerLabel(view.provider)}
                {view.emailVerified ? "" : " · address not confirmed"}
              </p>
            )}
            {signedIn && view.provider === "email" && !view.emailVerified && (
              <p className="mt-1 text-[10.5px] leading-relaxed text-amber-100/60">
                Email not confirmed yet. Nothing is blocked — confirm it whenever the link arrives.
              </p>
            )}
          </div>
        </div>

        {signedIn && (
          <div className="mt-3 space-y-2">
            {onAvatarChange && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={uploading}
                  className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full border border-white/[0.12] bg-white/[0.05]"
                  aria-label="Change profile picture"
                >
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Profile" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#c9e6d4] via-[#4a8a67] to-[#1f4a33] text-sm font-bold text-black">
                      {nameInitial(displayName || name || "U")}
                    </div>
                  )}
                  {uploading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    </div>
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-white/80">Profile picture</p>
                  <button
                    type="button"
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={uploading}
                    className="mt-1 text-[11px] text-white/45 transition-colors hover:text-white/70"
                  >
                    {uploading ? "Uploading..." : avatarUrl ? "Change" : "Upload"}
                  </button>
                  {avatarUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        onAvatarChange("");
                        setNotice("Profile picture removed.");
                      }}
                      disabled={uploading}
                      className="ml-2 mt-1 text-[11px] text-white/45 transition-colors hover:text-red-300/70"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleAvatarUpload(file);
                    e.target.value = "";
                  }}
                />
              </div>
            )}
            <label className="block">
              <span className="mb-1 block text-[10.5px] text-white/35">Display name</span>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={name}
                  maxLength={40}
                  onChange={(event) => setName(event.target.value)}
                  className="min-w-0 flex-1 rounded-lg border border-white/[0.09] bg-black/25 px-2.5 py-2 text-[12px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
                />
                <button
                  type="button"
                  onClick={saveName}
                  disabled={!name.trim() || name.trim() === displayName}
                  className="shrink-0 rounded-lg border border-white/[0.12] px-3 py-2 text-[11.5px] font-medium text-white/75 transition hover:bg-white/[0.06] disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </label>

            {view.provider === "email" && <PasswordForm />}

            <button
              type="button"
              onClick={() => void signOut()}
              disabled={busy}
              className="w-full rounded-xl border border-white/[0.09] py-2.5 text-[13px] font-medium text-white/70 transition hover:bg-white/[0.06] disabled:opacity-50"
            >
              {busy ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}

        {(unconfigured || unreachable) && (
          <p className="mt-2 text-[10.5px] leading-relaxed text-amber-100/60">
            {unconfigured
              ? "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY for this deployment, then rebuild."
              : "Sign-in is unavailable while the account service is unreachable."}
          </p>
        )}

        {error && <p className="mt-2.5 text-[11px] leading-relaxed text-red-200/80">{error}</p>}
        {notice && <p className="mt-2.5 text-[11px] leading-relaxed text-[#a9d8bb]/70">{notice}</p>}
      </div>

      {/* Collapsed by default: it is a diagnostic, not part of the account row. */}
      <AuthDiagnostics />
    </section>
  );
}

/**
 * Sets a new password on an email account.
 *
 * The reset mail signs the person back in through the PKCE flow, so this is also
 * the last step of "forgot password": after following the link, choose the new
 * password here.
 */
function PasswordForm() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await changePassword(password);
      setPassword("");
      setNotice("Password updated.");
    } catch (cause) {
      setError(describeLinkError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-white/40 transition-colors hover:text-white/65"
      >
        Change password
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-1.5">
      <span className="block text-[10.5px] text-white/35">New password</span>
      <div className="flex gap-1.5">
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="6+ characters"
          autoComplete="new-password"
          minLength={6}
          required
          className="min-w-0 flex-1 rounded-lg border border-white/[0.09] bg-black/25 px-2.5 py-2 text-[12px] text-white outline-none placeholder:text-white/25 focus:border-white/25"
        />
        <button
          type="submit"
          disabled={busy || password.length < 6}
          className="shrink-0 rounded-lg border border-white/[0.12] px-3 py-2 text-[11.5px] font-medium text-white/75 transition hover:bg-white/[0.06] disabled:opacity-40"
        >
          {busy ? "Saving…" : "Set"}
        </button>
      </div>
      {error && <p className="text-[10.5px] leading-relaxed text-red-200/80">{error}</p>}
      {notice && <p className="text-[10.5px] leading-relaxed text-[#a9d8bb]/75">{notice}</p>}
    </form>
  );
}
