// Sign in and register with an email address and a password, plus verification.

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
