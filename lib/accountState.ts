// Account state — what the interface knows about the current signed-in person.

/** Which credential the account signed in with. Null while signed out. */
export type AccountProvider = "google" | "github" | "microsoft" | "email" | null;

/** What Openmi knows about who is using it right now. */
export type AccountStatus =
  /** No NEXT_PUBLIC_SUPABASE_* values, so there is no account service to use. */
  | "unconfigured"
  /** Supabase is configured but not answering, so the state is unknown. */
  | "unreachable"
  /** No session. The sign-in screen is the whole interface in this state. */
  | "signed-out"
  /** A real account is signed in and every read and write carries its JWT. */
  | "signed-in";

export interface AccountView {
  status: AccountStatus;
  /** The `auth.users` id, which is what every owned row is scoped by. */
  id: string | null;
  /** The address on the account, when the provider supplied one. */
  email: string | null;
  /**
   * The name shown in the product: the one saved in `user_preferences` or
   * `profiles`, then the provider's own name, then the address's local part.
   */
  name: string | null;
  /** True when a session exists. The gate renders the product only for true. */
  signedIn: boolean;
  /**
   * Whether the address on the account has been confirmed.
   *
   * Only an email/password account can be unverified: Google, GitHub and
   * Microsoft vouch for the address themselves. Nothing is gated on this — an
   * unconfirmed account can still chat — so it is reported for the interface to
   * nudge, never to block.
   */
  emailVerified: boolean;
  /** Which credential the account signed in with, while signed in. */
  provider: AccountProvider;
}

export interface AccountInput {
  configured: boolean;
  /** False when Supabase could not be reached at all. */
  reachable?: boolean;
  /** Whether a session exists. */
  signedIn: boolean;
  id?: string | null;
  email?: string | null;
  name?: string | null;
  emailVerified?: boolean;
  provider?: AccountProvider;
}

/** How each provider is named in the interface. */
export const PROVIDER_LABELS: Record<Exclude<AccountProvider, null>, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  email: "email",
};

export function providerLabel(provider: AccountProvider): string {
  return provider ? PROVIDER_LABELS[provider] : "an account";
}

const SIGNED_OUT: AccountView = {
  status: "signed-out",
  id: null,
  email: null,
  name: null,
  signedIn: false,
  emailVerified: false,
  provider: null,
};

/**
 * Reduces what the auth server reports to the one thing the interface needs:
 * is this person signed in, and with what?
 *
 * `reachable === false` is kept separate from `configured === false`. One is a
 * deployment without a project; the other is a project that could not answer.
 * They need different sentences and different next steps.
 */
export function describeAccount(input: AccountInput): AccountView {
  if (!input.configured) {
    return {
      status: "unconfigured",
      id: null,
      email: null,
      name: null,
      signedIn: false,
      emailVerified: false,
      provider: null,
    };
  }
  if (input.reachable === false) {
    return {
      status: "unreachable",
      id: null,
      email: null,
      name: null,
      signedIn: false,
      emailVerified: false,
      provider: null,
    };
  }
  if (!input.signedIn) return SIGNED_OUT;

  return {
    status: "signed-in",
    id: input.id ?? null,
    email: input.email ?? null,
    name: input.name ?? null,
    signedIn: true,
    emailVerified: input.emailVerified ?? true,
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
    case "signed-in":
      return view.email ?? displayName ?? "Signed in";
    case "signed-out":
    default:
      return "Not signed in";
  }
}

/** The sentence under the settings row. */
export function accountExplanation(view: AccountView): string {
  switch (view.status) {
    case "unconfigured":
      return "Add the NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY values and redeploy. Openmi needs an account service to sign anyone in.";
    case "unreachable":
      return "Nothing has changed. Your chats stay on this device — check the connection and try again in a moment.";
    case "signed-in":
      return `Signed in with ${providerLabel(view.provider)}. Your chats and preferences follow you to any browser you sign in from.`;
    case "signed-out":
    default:
      return "Sign in with Google, GitHub, Microsoft or email to use Openmi. Your chats and preferences stay with your account.";
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
const AUTH_ERRORS: Record<string, string> = {
  // ── OAuth ─────────────────────────────────────────────────────────────────
  access_denied: "Sign-in was cancelled.",
  provider_disabled:
    "That sign-in method is switched off for this project. Open the Supabase dashboard → Authentication → Sign In / Providers and turn it on.",
  oauth_provider_not_supported:
    "That provider is not enabled for this project. Turn it on in Auth → Sign In / Providers.",
  manual_linking_disabled:
    "This project cannot attach a second sign-in method to an account. In Auth → Settings, turn on manual linking.",
  identity_already_exists:
    "That account is already linked elsewhere. Sign in to it there instead.",
  bad_oauth_state: "The sign-in link expired. Start again from the sign-in screen.",
  bad_oauth_callback:
    "The sign-in came back in a shape this project does not accept. Start again from the sign-in screen.",
  over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
  over_email_send_rate_limit:
    "Too many emails have been sent. Wait a few minutes before trying again.",
  signup_disabled:
    "Sign-ups are switched off for this project. In the Supabase dashboard → Authentication → Sign In / Providers, turn on Allow new users to sign up.",
  email_not_confirmed:
    "That address has not been confirmed yet. Check your inbox for the link, then try again.",
  user_banned: "That account has been disabled.",
  provider_email_needs_verification:
    "The provider did not confirm your address. Confirm it and try again.",
  session_not_found: "That session has expired. Sign in again.",
  session_expired: "That session has expired. Sign in again.",
  reauthentication_needed:
    "For safety, sign in again before changing your account.",

  // ── email and password ────────────────────────────────────────────────────
  email_address_invalid: "That is not a valid email address.",
  validation_failed: "That email address is not one this project accepts.",
  email_address_not_authorized: "This project cannot send mail to that address.",
  weak_password: "Use at least six characters for your password.",
  email_exists:
    "An account already exists for that address. Sign in instead — your chats come with you.",
  user_already_exists:
    "An account already exists for that address. Sign in instead — your chats come with you.",
  invalid_credentials: "That email and password do not match an account.",
  user_not_found: "There is no account for that address. Create one instead.",
  same_password: "Choose a password you have not used on this account before.",
  email_provider_disabled:
    "Email sign-in is switched off. In the Supabase dashboard → Authentication → Sign In / Providers, turn on Email.",
  "auth/unconfigured":
    "This deployment has no Supabase project configured, so accounts are unavailable.",
};

export function describeLinkError(cause: unknown): string {
  const error = cause as { code?: string; name?: string } | null;
  const code = error?.code ?? error?.name ?? "";
  if (AUTH_ERRORS[code]) return AUTH_ERRORS[code];
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
 * The provider's display name is the last resort, and is used only when the
 * account holds no name either — it is the one value here that Openmi did not
 * ask the person for, so it is the one least entitled to represent them.
 */
export function greetingName(
  localName: string,
  accountName: string | null | undefined,
  providerName: string | null | undefined
): string | null {
  if (normalizeName(localName)) return null;
  return resolveName("", accountName) ?? resolveName("", providerName);
}
