// ── Signing in with an email address and a password ──────────────────────────
//
// Firebase Auth owns the credential: the password is hashed and stored by the
// project, never by this app, and the result is an ordinary Firebase ID token.
// That is the whole reason this door was added rather than a bespoke user table:
// `verifyCaller` in lib/serverControl.ts already turns that token into a uid,
// the rules already scope every node to that uid, and the Dew wallet and the
// chat history already hang off it. An email account is therefore the *same
// kind of account* as a Google one — only the credential differs.
//
// ── Why registering links instead of creating ────────────────────────────────
// The app signs every first-time visitor in anonymously, so they already have a
// uid and possibly chats under it. `linkWithCredential` attaches the new
// email/password credential to that *existing* account, which leaves the uid
// alone — so registering is an upgrade, not a migration. Creating a fresh user
// with `createUserWithEmailAndPassword` would hand back a different uid and
// orphan everything written so far, which is exactly the failure the Google
// door in lib/account.ts was written to avoid.
//
// If the address already belongs to an account, the link is refused and the
// right move is the opposite one: sign into that account, and let the caller
// re-sync this device's chats onto it. Both paths end in the same outcome type,
// so the interface can tell them apart without knowing why.
//
// ── Verification ─────────────────────────────────────────────────────────────
// Registering sends a confirmation mail. Nothing is gated on it: an
// unconfirmed account can still chat, and the interface offers a resend rather
// than a wall. That is deliberate — a person who cannot receive mail at that
// address yet must not lose access to a product they are already using.

import {
  EmailAuthProvider,
  linkWithCredential,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { accountViewOf, saveAccountName } from "./account";
import { firebaseConfigured, getServices } from "./firebaseHistory";
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
  return firebaseConfigured;
}

const UNCONFIGURED =
  "This deployment has no Firebase project configured, so accounts are not available.";

function codeOf(cause: unknown): string {
  return (cause as { code?: string } | null)?.code ?? "";
}

/**
 * The account services, or a thrown error carrying a code the interface can
 * describe. `auth/unconfigured` has its own sentence in accountState.ts, so the
 * form renders a real explanation instead of "unconfigured".
 */
async function services() {
  const current = await getServices();
  if (!current) {
    throw Object.assign(new Error(UNCONFIGURED), { code: "auth/unconfigured" });
  }
  return current;
}

/** Writes the name onto the credential and remembers it for other browsers. */
async function applyName(user: User, name?: string): Promise<void> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    await saveAccountName(null);
    return;
  }
  try {
    await updateProfile(user, { displayName: trimmed.slice(0, 40) });
  } catch {
    // A display name is a convenience; the account is already signed in.
  }
  await saveAccountName(trimmed);
}

/**
 * Sends the confirmation mail, best effort.
 *
 * Some projects have email verification switched off entirely, and some
 * environments refuse the request outright. Neither is a reason to fail a
 * registration that already succeeded, so the caller is told to offer a resend
 * rather than shown an error.
 */
async function requestVerification(user: User): Promise<boolean> {
  try {
    await sendEmailVerification(user);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates an account for an address, or signs into the one that already exists.
 *
 * The anonymous account is upgraded in place when it can be, which is what keeps
 * the chats already written under this browser's uid exactly where they are.
 */
export async function registerWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<EmailAuthResult> {
  const current = await services();
  const existing = current.user ?? (await current.ensureUser());

  if (existing.isAnonymous) {
    try {
      const credential = EmailAuthProvider.credential(email, password);
      const result = await linkWithCredential(existing, credential);
      await applyName(result.user, name);
      const sent = await requestVerification(result.user);
      return {
        outcome: "linked",
        view: accountViewOf(result.user),
        needsVerification: sent && !result.user.emailVerified,
      };
    } catch (cause) {
      const code = codeOf(cause);
      // The address already has an account. That is not a dead end: it is the
      // signal to sign into it, which the block below does.
      const alreadyExists =
        code === "auth/email-already-in-use" ||
        code === "auth/credential-already-in-use" ||
        code === "auth/provider-already-linked";
      if (!alreadyExists) throw cause;
    }
  }

  const credential = await signInWithEmailAndPassword(current.auth, email, password);
  await applyName(credential.user, name);
  const sent = credential.user.emailVerified ? false : await requestVerification(credential.user);
  return {
    outcome: credential.user.uid === existing.uid ? "linked" : "adopted",
    view: accountViewOf(credential.user),
    needsVerification: sent && !credential.user.emailVerified,
  };
}

/** Signs into an existing email/password account. */
export async function signInWithEmail(
  email: string,
  password: string,
  name?: string
): Promise<EmailAuthResult> {
  const current = await services();
  const before = current.user?.uid ?? "";
  const credential = await signInWithEmailAndPassword(current.auth, email, password);
  await applyName(credential.user, name);
  return {
    outcome: credential.user.uid === before ? "linked" : "adopted",
    view: accountViewOf(credential.user),
    needsVerification: !credential.user.emailVerified,
  };
}

/**
 * Returns this device to an anonymous guest.
 *
 * Signing out and immediately signing in anonymously is the same move
 * `detachGoogleAccount` makes, and for the same reason: Firebase deletes an
 * account that has no credential left, so removing the provider would throw the
 * history away. The account stays; this browser simply stops being it.
 */
export async function signOutToGuest(): Promise<AccountView> {
  const current = await services();
  await signOut(current.auth);
  return accountViewOf(await current.ensureUser());
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
  const current = await services();
  const user = current.user;
  if (!user) return { verified: false, view: null };
  try {
    await reload(user);
  } catch {
    // A failed reload leaves the last known state in place.
  }
  return { verified: user.emailVerified, view: accountViewOf(user) };
}

/** Sends the confirmation mail again. False when it could not be sent. */
export async function resendVerificationEmail(): Promise<boolean> {
  const current = await services();
  const user = current.user;
  if (!user) return false;
  if (user.emailVerified) return true;
  return requestVerification(user);
}

/**
 * Sends a password-reset mail.
 *
 * The address is not disclosed: Firebase answers the same way whether or not an
 * account exists, which is why the interface says "if that address has an
 * account" rather than "sent".
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const current = await services();
  await sendPasswordResetEmail(current.auth, email.trim());
}
