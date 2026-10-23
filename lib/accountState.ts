// ── Visitor account state ────────────────────────────────────────────────────
// Pure logic only. Nothing here imports Supabase, so the rules that decide what
// a visitor is shown — and what happens to their name when they bind — can be
// tested without a browser, a network, or a project.
//
// This is the user-facing account, and it is deliberately not the administrator's
// one. Binding a Google identity grants exactly what the row-level security
// policies grant `authenticated`, and nothing else: elevation is decided by the
// policies in `supabase/migrations` comparing one address, so there is no code
// path here by which signing in could reach the console. See the note on
// bindGoogleAccount in lib/account.ts.

/** Which credential the account signed in with. Null for a guest. */
export type AccountProvider = "google" | "email" | null;

/** What Openmi knows about who is using it right now. */
export type AccountStatus =
  /** No NEXT_PUBLIC_SUPABASE_* values, so there is no account to have. */
  | "unconfigured"
  /** Supabase is configured but not answering, so the state is unknown. */
  | "unreachable"
  /** Signed in with no provider: a name and a local database, nothing portable. */
  | "guest"
  /** A Google account is attached to this identity. */
  | "linked";

export interface AccountView {
  status: AccountStatus;
  /** The address on the linked Google account, when there is one. */
  email: string | null;
  /**
   * The name Google holds for the account. It is the weakest of the three names
   * available — a name the person typed beats a name they chose on another site
   * — and it is the only one Openmi never asked them for.
   */
  name: string | null;
  /** True when a Google account is attached. */
  isLinked: boolean;
  /**
   * True when the account can still be bound. A guest can always be upgraded; a
   * linked account is already what binding would produce.
   */
  canBind: boolean;
  /**
   * Whether the address on the account has been confirmed.
   *
   * Only an email/password account can be unverified: Google vouches for the
   * address itself. Nothing is gated on this — an unconfirmed account can still
   * chat — so it is reported for the interface to nudge, never to block.
   */
  emailVerified: boolean;
  /** Which credential the account signed in with, when it is not a guest. */
  provider: AccountProvider;
}

export interface AccountInput {
  configured: boolean;
  /** False when Supabase could not be reached at all. */
  reachable?: boolean;
  /** null when no one is signed in yet. */
  signedIn: boolean;
  isAnonymous?: boolean;
  email?: string | null;
  name?: string | null;
  emailVerified?: boolean;
  provider?: AccountProvider;
}

/**
 * Reduces what the auth server reports to the one thing the interface needs: is
 * this person a guest, or has an account?
 *
 * The distinction is drawn from `isAnonymous` rather than from whether an email
 * exists, because a Google account always has one and an anonymous account
 * never does, while "signed in but anonymous" is exactly the state a guest is
 * in and the one binding exists to change.
 */
const GUEST_VIEW: AccountView = {
  status: "guest",
  email: null,
  name: null,
  isLinked: false,
  canBind: true,
  emailVerified: false,
  provider: null,
};

export function describeAccount(input: AccountInput): AccountView {
  if (!input.configured) {
    return {
      status: "unconfigured",
      email: null,
      name: null,
      isLinked: false,
      canBind: false,
      emailVerified: false,
      provider: null,
    };
  }
  if (input.reachable === false) {
    return {
      status: "unreachable",
      email: null,
      name: null,
      isLinked: false,
      canBind: false,
      emailVerified: false,
      provider: null,
    };
  }
  if (!input.signedIn) {
    // The project is fine and simply has not signed anyone in yet. The app signs
    // a first-time visitor in anonymously, so this is brief and not an error.
    return GUEST_VIEW;
  }

  if (input.isAnonymous) return GUEST_VIEW;
  return {
    status: "linked",
    email: input.email ?? null,
    name: input.name ?? null,
    isLinked: true,
    canBind: false,
    emailVerified: input.emailVerified ?? false,
    provider: input.provider ?? null,
  };
}

/** One line describing the account, for the settings row. */
export function accountHeadline(view: AccountView, displayName: string): string {
  switch (view.status) {
    case "unconfigured":
      return "Accounts are not set up on this deployment";
    case "unreachable":
      return "Openmi cannot reach the account service";
    case "linked":
      return view.email ?? "Linked to a Google account";
    case "guest":
    default:
      return displayName
        ? `${displayName} · on this device only`
        : "On this device only";
  }
}

/** The sentence under the settings row. */
export function accountExplanation(view: AccountView): string {
  switch (view.status) {
    case "unconfigured":
      return "Add the NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY values and redeploy to turn this on. Everything else about Openmi keeps working without it.";
    case "unreachable":
      return "Nothing has changed. Your chats and your name are still on this device — check the connection and try again in a moment.";
    case "linked":
      return "Your account and its chats follow you to any browser you sign in from. Detaching returns this device to a name on its own.";
    case "guest":
    default:
      return "Link a Google account and your chats follow you to any browser you sign in from. Your name stays the same either way, and you can still use Openmi without an account.";
  }
}

/**
 * Supabase's error codes, turned into something worth reading on a phone.
 *
 * These are the failures that are actually reachable here, and each one has a
 * concrete cause the person can act on. Anything unrecognised keeps its own
 * message rather than being replaced with a guess — Supabase's own text is often
 * more specific than the code the SDK exposes.
 */
const LINK_ERRORS: Record<string, string> = {
  // ── OAuth ─────────────────────────────────────────────────────────────────
  "access_denied": "Sign-in was cancelled.",
  "provider_disabled":
    "Google sign-in is switched off. In the Supabase dashboard → Authentication → Sign In / Providers, turn on Google.",
  "oauth_provider_not_supported":
    "That provider is not enabled for this project. Turn it on in Auth → Sign In / Providers.",
  "anonymous_provider_disabled":
    "Anonymous sign-ins are switched off, so Openmi cannot start a guest session. In the Supabase dashboard → Authentication → Sign In / Providers, turn on Anonymous sign-ins.",
  "manual_linking_disabled":
    "This project cannot attach a second sign-in method to an account. In Auth → Settings, turn on manual linking.",
  "identity_already_exists":
    "That Google account is already linked elsewhere. Sign in to it there instead — your existing chats are waiting.",
  "bad_oauth_state": "The sign-in link expired. Start again from this page.",
  "bad_oauth_callback": "The sign-in came back in a shape this project does not accept. Start again from this page.",
  "over_request_rate_limit": "Too many attempts. Wait a minute and try again.",
  "over_email_send_rate_limit":
    "Too many emails have been sent. Wait a few minutes before trying again.",
  "signup_disabled":
    "Sign-ups are switched off for this project. In the Supabase dashboard → Authentication → Sign In / Providers, turn on Allow new users to sign up.",
  "email_not_confirmed":
    "That address has not been confirmed yet. Check your inbox for the link, then try again.",
  "user_banned": "That account has been disabled.",
  "session_not_found": "That session has expired. Sign in again.",
  "session_expired": "That session has expired. Sign in again.",
  "reauthentication_needed":
    "For safety, sign in again before changing what is linked to this account.",

  // ── email and password ────────────────────────────────────────────────────
  // Reachable from the register and sign-in forms. Each says what to do next
  // rather than restating the code, because the code is not the useful part.
  "email_address_invalid": "That is not a valid email address.",
  "validation_failed": "That email address is not one this project accepts.",
  "email_address_not_authorized": "This project cannot send mail to that address.",
  "weak_password": "Use at least six characters for your password.",
  "email_exists":
    "An account already exists for that address. Sign in instead — your chats come with you.",
  "user_already_exists":
    "An account already exists for that address. Sign in instead — your chats come with you.",
  "invalid_credentials": "That email and password do not match an account.",
  "user_not_found": "There is no account for that address. Create one instead.",
  "same_password": "Choose a password you have not used on this account before.",
  "provider_email_needs_verification":
    "Confirm your current address before changing it. Check your inbox for the link.",
  "email_provider_disabled":
    "Email sign-in is switched off. In the Supabase dashboard → Authentication → Sign In / Providers, turn on Email.",
  "auth/unconfigured": "This deployment has no Supabase project configured, so accounts are unavailable.",
};

export function describeLinkError(cause: unknown): string {
  const error = cause as { code?: string; name?: string } | null;
  const code = error?.code ?? error?.name ?? "";
  if (LINK_ERRORS[code]) return LINK_ERRORS[code];
  return cause instanceof Error ? cause.message : String(cause ?? "Something went wrong.");
}

/** True when a failure is the person closing the window, which is not a problem. */
export function isDismissed(cause: unknown): boolean {
  const error = cause as { code?: string; message?: string } | null;
  const code = error?.code ?? "";
  if (code === "access_denied") return true;
  // A closed tab never reaches a callback, so the only other shape this takes is
  // the provider's own words in the redirect.
  return /access_denied|user (cancelled|denied)|cancelled/i.test(error?.message ?? "");
}

// ── The name ─────────────────────────────────────────────────────────────────

/** Matches the 40-character limit the database enforces on a stored name. */
export const NAME_MAX = 40;

export function normalizeName(name: string | null | undefined): string {
  return (name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
}

/**
 * Decides which name to show when the browser and the account disagree.
 *
 * A name typed on this device always wins. The account's copy exists so a person
 * signing in on a *new* browser is greeted by the name they already chose, and
 * silently replacing a name someone just corrected would be a worse bug than
 * showing a stale one.
 *
 * Returns null when there is nothing worth adopting, which the caller reads as
 * "leave the name alone".
 */
export function resolveName(
  localName: string,
  accountName: string | null | undefined
): string | null {
  const local = normalizeName(localName);
  if (local) return null;
  const remote = normalizeName(accountName);
  return remote ? remote : null;
}

/**
 * The name a returning person should be greeted with when they have an account
 * and no name on this device.
 *
 * Returns null when this browser already has a name. That is the whole contract:
 * this function is only ever called to fill a gap, and a gap that is not there
 * must not be filled over the top of an answer the person already gave.
 *
 * The Google display name is the last resort, and is used only when the account
 * holds no name either — it is the one value here that Openmi did not ask the
 * person for, so it is the one least entitled to represent them.
 */
export function greetingName(
  localName: string,
  accountName: string | null | undefined,
  googleName: string | null | undefined
): string | null {
  if (normalizeName(localName)) return null;
  return resolveName("", accountName) ?? resolveName("", googleName);
}
