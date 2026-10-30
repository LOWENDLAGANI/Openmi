// ── Signing in with an email address and a password ──────────────────────────
//
// Supabase Auth owns the credential: the password is hashed and stored by the
// project, never by this app, and the result is an ordinary Supabase session.
// That is the whole reason this door exists rather than a bespoke user table:
// `verifyCaller` in lib/serverControl.ts already turns that token into a uid,
// the policies already scope every row to that uid, and the Dew wallet, the chat
// history and the preferences already hang off it. An email account is therefore
// the *same kind of account* as a Google one — only the credential differs.
//
// ── Registering creates an account ──────────────────────────────────────────
// There is no anonymous user to upgrade any more. `signUp` creates a real
// Supabase user with the address and the password, plus the name the form
// collected as metadata, so the first browser and every later one can greet the
// person by it.
//
// ── Verification ─────────────────────────────────────────────────────────────
// Registering sends a confirmation mail when the project has confirmation on.
// Nothing is gated on it: an unconfirmed account can still chat, and the
// interface offers a resend rather than a wall. A person who cannot receive mail
// at that address yet must not lose access to a product they are already using.
// A project with confirmation switched off signs the person in immediately, and
// `needsVerification` answers false.
//
// ── Password recovery ───────────────────────────────────────────────────────
// The reset mail returns through the project's PKCE flow, which signs the person
// in, and the account row then offers "Set a new password" through
// `changePassword`. Nothing here ever sees or stores the password itself.

import type { User } from "@supabase/supabase-js";
import { accountViewOf } from "./account";
import { recoveryRedirectUrl } from "./passwordRecovery";
import { getSupabase } from "./supabase";
import type { AccountView } from "./accountState";

/** What an email sign-in or registration actually did. */
export interface EmailAuthResult {
  /** The account as the interface should render it, when a session exists. */
  view: AccountView | null;
  /**
   * True while the address still has to be confirmed. With confirmation on,
   * `signUp` returns a user but no session, so there is nothing to render until
   * the link is followed.
   */
  needsVerification: boolean;
}

/** Whether this deployment can offer the door at all. */
export function emailAuthAvailable(): boolean {
  return getSupabase() !== null;
}

const UNCONFIGURED =
  "This deployment has no Supabase project configured, so accounts are not available.";

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

/** The origin the confirmation or reset mail should come back to. */
function returnUrl(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

/**
 * True while the signed-in account is unconfirmed.
 *
 * `new_email` is how Supabase reports "this address is waiting for its link"
 * while an existing account changes address; otherwise the account's own
 * `email_confirmed_at` is the answer.
 */
function needsVerification(user: User | null): boolean {
  if (!user) return false;
  if (user.new_email) return true;
  return !user.email_confirmed_at;
}

/**
 * Creates an account for an address.
 *
 * With confirmation switched on the project returns the user and no session,
 * which is not an error: the interface asks the person to open the mail. With it
 * switched off a session comes back immediately and the product opens.
 *
 * An address that already has an account is answered with a deliberately empty
 * user by Supabase. That is turned into `email_exists` here so the form can say
 * "sign in instead" rather than appear to have registered a second person.
 */
export async function registerWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<EmailAuthResult> {
  const supabase = client();
  const address = email.trim();
  const trimmedName = (name ?? "").trim().slice(0, 40);

  const { data, error } = await supabase.auth.signUp({
    email: address,
    password,
    options: {
      emailRedirectTo: returnUrl(),
      data: trimmedName ? { name: trimmedName } : undefined,
    },
  });
  if (error) throw error;

  // Supabase's anti-enumeration answer for an address that already exists: a
  // user object with no identities. Signing in is the right next step.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw Object.assign(
      new Error("An account already exists for that address."),
      { code: "email_exists" }
    );
  }

  if (!data.session) {
    return { view: null, needsVerification: true };
  }
  return { view: accountViewOf(data.session.user), needsVerification: needsVerification(data.session.user) };
}

/** Signs into an existing email/password account. */
export async function signInWithEmail(email: string, password: string): Promise<EmailAuthResult> {
  const supabase = client();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) throw error;
  return {
    view: accountViewOf(data.user),
    needsVerification: needsVerification(data.user),
  };
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
export async function resendVerificationEmail(email: string): Promise<boolean> {
  const supabase = client();
  const address = email.trim();
  if (!address) return false;
  try {
    const { error } = await supabase.auth.resend({
      type: "signup",
      email: address,
      options: { emailRedirectTo: returnUrl() },
    });
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
  const origin = returnUrl();
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    // The recovery session must land on the screen that asks for a new password.
    // Returning to the product would sign the person in and leave the old
    // password in place, which is the halfway state this screen removes.
    redirectTo: origin ? recoveryRedirectUrl(origin) : undefined,
  });
  if (error) throw error;
}

/**
 * Sets a new password on the signed-in account.
 *
 * Reachable after a reset mail has signed the person back in, and from the
 * account row for an email account that simply wants a different password.
 */
export async function changePassword(password: string): Promise<void> {
  const supabase = client();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}
