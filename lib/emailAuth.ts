// ── Signing in with an email address and a password ──────────────────────────
//
// Supabase Auth owns the credential: the password is hashed and stored by the
// project, never by this app, and the result is an ordinary Supabase session.
// That is the whole reason this door exists rather than a bespoke user table:
// `verifyCaller` in lib/serverControl.ts already turns that token into a uid,
// the policies already scope every row to that uid, and the Dew wallet and the
// chat history already hang off it. An email account is therefore the *same kind
// of account* as a Google one — only the credential differs.
//
// ── Why registering upgrades instead of creating ────────────────────────────
// The app signs every first-time visitor in anonymously, so they already have a
// uid and possibly chats under it. Supabase's documented way to keep that is
// `updateUser({ email, password })` on the anonymous user: the address and the
// password are added to the account already in use, and the uid does not move.
// Registering is therefore an upgrade, not a migration. Creating a fresh user
// would hand back a different uid and orphan everything written so far, which is
// exactly the failure the Google door in lib/account.ts avoids too.
//
// If the address already belongs to an account, the update is refused and the
// right move is the opposite one: sign into that account, and let the caller
// re-sync this device's chats onto it. Both paths end in the same outcome type,
// so the interface can tell them apart without knowing why.
//
// ── Verification ─────────────────────────────────────────────────────────────
// Registering sends a confirmation mail when the project has confirmation on.
// Nothing is gated on it: an unconfirmed account can still chat, and the
// interface offers a resend rather than a wall. A person who cannot receive mail
// at that address yet must not lose access to a product they are already using.
// A project with confirmation switched off signs the person in immediately, and
// `needsVerification` answers false.

import type { User } from "@supabase/supabase-js";
import { accountViewOf, isAnonymousUser, saveAccountName } from "./account";
import { ensureUser, getSupabase } from "./supabase";
import type { AccountView } from "./accountState";

/** What an email sign-in or registration actually did. */
export interface EmailAuthResult {
  /**
   * `linked` means the uid did not change (a guest was upgraded in place).
   * `adopted` means it did, and the caller must re-sync local chats onto the
   * account it just signed into.
   */
  outcome: "linked" | "adopted";
  view: AccountView;
  /** True while the address is still unconfirmed. Never blocks anything. */
  needsVerification: boolean;
}

/** Whether this deployment can offer the door at all. */
export function emailAuthAvailable(): boolean {
  return getSupabase() !== null;
}

const UNCONFIGURED =
  "This deployment has no Supabase project configured, so accounts are not available.";

function codeOf(cause: unknown): string {
  return (cause as { code?: string } | null)?.code ?? "";
}

/**
 * The client, or a thrown error carrying a code the interface can describe.
 * `auth/unconfigured` has its own sentence in accountState.ts, so the form
 * renders a real explanation instead of "unconfigured".
 */
function client() {
  const supabase = getSupabase();
  if (!supabase) {
    throw Object.assign(new Error(UNCONFIGURED), { code: "auth/unconfigured" });
  }
  return supabase;
}

/** Writes the name onto the user's metadata and remembers it for other browsers. */
async function applyName(name?: string): Promise<void> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    await saveAccountName(null);
    return;
  }
  try {
    await client().auth.updateUser({ data: { name: trimmed.slice(0, 40) } });
  } catch {
    // A display name is a convenience; the account is already signed in.
  }
  await saveAccountName(trimmed);
}

/**
 * True while a confirmation mail has been sent but not acted on.
 *
 * `new_email` is how Supabase reports "this address is waiting for its link" —
 * it happens only when confirmation is enabled for the project, and the user is
 * still the anonymous one until the link is followed.
 */
function needsVerification(user: User | null): boolean {
  if (!user) return false;
  if (user.new_email) return true;
  if (isAnonymousUser(user)) return false;
  return !user.email_confirmed_at;
}

/**
 * Creates an account for an address, or signs into the one that already exists.
 *
 * The anonymous user is upgraded in place when it can be, which is what keeps
 * the chats already written under this browser's uid exactly where they are.
 */
export async function registerWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<EmailAuthResult> {
  const supabase = client();
  const existing = await ensureUser();
  const address = email.trim();

  if (existing && isAnonymousUser(existing)) {
    const { data, error } = await supabase.auth.updateUser({
      email: address,
      password,
      data: name ? { name: name.trim().slice(0, 40) } : undefined,
    });

    if (!error) {
      const user = data.user ?? existing;
      if (name) await saveAccountName(name);
      return {
        outcome: "linked",
        view: accountViewOf(user),
        needsVerification: needsVerification(user),
      };
    }

    // The address already has an account. That is not a dead end: it is the
    // signal to sign into it, which the block below does.
    const alreadyExists =
      codeOf(error) === "email_exists" ||
      codeOf(error) === "user_already_exists" ||
      /already (registered|exists)/i.test(error.message ?? "");
    if (!alreadyExists) throw error;
  }

  const signIn = await supabase.auth.signInWithPassword({ email: address, password });
  if (signIn.error) throw signIn.error;
  await applyName(name);
  return {
    outcome: signIn.data.user?.id === existing?.id ? "linked" : "adopted",
    view: accountViewOf(signIn.data.user),
    needsVerification: needsVerification(signIn.data.user),
  };
}

/** Signs into an existing email/password account. */
export async function signInWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<EmailAuthResult> {
  const supabase = client();
  const before = (await ensureUser())?.id ?? "";
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
  await applyName(name);
  return {
    outcome: data.user?.id === before ? "linked" : "adopted",
    view: accountViewOf(data.user),
    needsVerification: needsVerification(data.user),
  };
}

/**
 * Returns this device to an anonymous guest.
 *
 * Signing out and immediately signing in anonymously is the same move
 * `detachGoogleAccount` makes, and for the same reason: the account keeps its
 * history, and this browser simply stops being it. The account is not deleted —
 * nothing here deletes a user.
 */
export async function signOutToGuest(): Promise<AccountView> {
  const supabase = client();
  await supabase.auth.signOut();
  return accountViewOf(await ensureUser());
}

/**
 * Re-reads the account from the server and reports whether the address is now
 * confirmed. Returns the fresh view so the caller can render it immediately
 * instead of waiting for the next token refresh.
 */
export async function refreshVerification(): Promise<{
  verified: boolean;
  view: AccountView | null;
}> {
  const supabase = client();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    // A failed refresh leaves the last known state in place.
    const { data: session } = await supabase.auth.getSession();
    return { verified: Boolean(session.session?.user?.email_confirmed_at), view: null };
  }
  return {
    verified: Boolean(data.user.email_confirmed_at),
    view: accountViewOf(data.user),
  };
}

/** Sends the confirmation mail again. False when it could not be sent. */
export async function resendVerificationEmail(): Promise<boolean> {
  const supabase = client();
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) return false;
  if (user.email_confirmed_at) return true;
  const address = user.new_email ?? user.email;
  if (!address) return false;
  try {
    const { error } = await supabase.auth.resend({ type: "signup", email: address });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Sends a password-reset mail.
 *
 * The address is not disclosed: Supabase answers the same way whether or not an
 * account exists, which is why the interface says "if that address has an
 * account" rather than "sent".
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const supabase = client();
  const redirectTo = typeof window === "undefined" ? undefined : window.location.origin;
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
  if (error) throw error;
}
