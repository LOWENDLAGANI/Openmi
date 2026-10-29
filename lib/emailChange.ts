// ── Changing the address an account signs in with ───────────────────────────
//
// This is the one write in the account path that can move an account out of the
// hands of the person holding it, which is why it is its own module and why it
// is never a plain field write: `updateUser({ email })` asks Supabase to send a
// confirmation link, and the address only changes when that link is opened. With
// "Secure email change" switched on in the project — the setting a paid product
// should have — Supabase sends the link to the old address and the new one, and
// both have to be followed. Neither this file nor the screen can shortcut that.
//
// Two things this deliberately does not do:
//
//   * It never touches the password. Adding a password to a provider account and
//     changing its address are separate decisions, and folding them into one form
//     would make a typo in either one a credential problem.
//   * It never reports success. Supabase returns as soon as the mail is queued,
//     with the account still on its old address (`new_email` holds the pending
//     one), so the screen says "confirmation sent", never "changed".

import { emailChangeProblem } from "./accountState";
import { getSupabase } from "./supabase";

/** The address a confirmation has been queued for. */
export interface EmailChangeRequest {
  /** The address being confirmed, lower-cased the way Supabase stores it. */
  to: string;
}

/** Where the confirmation link comes back to. */
function returnUrl(): string | undefined {
  return typeof window === "undefined" ? undefined : `${window.location.origin}/chat`;
}

/**
 * Asks Supabase to move the account to another address.
 *
 * The rules — a real-looking address, not the one already in use — are checked
 * here so a mistyped request fails with a sentence instead of a mail that cannot
 * be completed. The database still has the final say: an address belonging to
 * another account is refused by Supabase, and that refusal is what
 * `describeLinkError` turns into "sign in instead".
 */
export async function requestEmailChange(nextEmail: string): Promise<EmailChangeRequest> {
  const client = getSupabase();
  if (!client) {
    throw Object.assign(
      new Error("This deployment has no Supabase project configured, so accounts are unavailable."),
      { code: "auth/unconfigured" }
    );
  }

  const { data, error: readError } = await client.auth.getUser();
  if (readError) throw readError;

  const address = nextEmail.trim().toLowerCase();
  const problem = emailChangeProblem(data.user?.email ?? null, address);
  if (problem) {
    // A rule this app owns, not the provider's: the message is already the
    // sentence the form should show, so it travels as its own code.
    throw Object.assign(new Error(problem), { code: "email_change/invalid" });
  }

  const { error } = await client.auth.updateUser({ email: address }, { emailRedirectTo: returnUrl() });
  if (error) throw error;
  return { to: address };
}

/**
 * The address waiting for its link, if there is one.
 *
 * Read from the session rather than kept in this browser: a confirmation started
 * on a phone and finished on a laptop is one change, and a pending address stored
 * locally would only be true on the device that typed it. A failure to read is
 * "nothing pending" — a banner is not worth an error.
 */
export async function pendingEmailChange(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;
  try {
    const { data } = await client.auth.getUser();
    return data.user?.new_email ?? null;
  } catch {
    return null;
  }
}
