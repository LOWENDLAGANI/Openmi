// ── The account ──────────────────────────────────────────────────────────────
// Signing in with Google, GitHub, Microsoft or email, signing out, and carrying
// a name and preferences across browsers. This is the user's account and not the
// administrator's: nothing here can grant console access, and nothing here reads
// the console's data.
//
// ── Every visitor has an account ────────────────────────────────────────────
// The guest-first build is gone. There is no anonymous Supabase user, so a first
// visit lands on the sign-in screen and the product is only usable once one of
// the four doors has produced a session. That is what makes the rest of the
// promise honest: every chat, preference and push subscription belongs to a real
// `auth.users` row and follows the person to another browser.
//
// ── OAuth is a redirect, not a popup ────────────────────────────────────────
// Supabase's OAuth is a full-page round trip. That is the shape most large sites
// use, and it removes a class of failure the popup path had: extensions, strict
// pop-up settings and embedded views that block `window.open` no longer matter.
// `detectSessionInUrl` in lib/supabase.ts exchanges the returned code for a
// session when the page loads again, and `watchAccount` reports it. A provider
// that refuses the sign-in puts its reason in the URL, which
// `consumeOAuthError` reads once and the sign-in screen shows.
//
// Elevation is decided entirely by the policies in `supabase/migrations`, which
// compare one address seeded in `app_admin`. Signing in grants a token and
// nothing else, so there is no path from this file to the admin console even for
// the person who owns it.

import type { Provider, User } from "@supabase/supabase-js";
import { currentUser, getSupabase, withTimeout } from "./supabase";
import { isSupportedTimeZone } from "./dew";
import {
  describeAccount as viewFromUser,
  describeLinkReturn,
  normalizeName,
  OAUTH_PROVIDER_IDS,
  signInMethodLabel,
  type AccountProvider,
  type AccountView,
  type LinkableProvider,
  type SignInMethod,
} from "./accountState";

/** The three OAuth doors the interface offers. */
export type OAuthProvider = LinkableProvider;

/** Supabase's provider id for each door. Microsoft is `azure` in the dashboard. */
const PROVIDER_IDS: Record<OAuthProvider, Provider> = OAUTH_PROVIDER_IDS;

/**
 * The scopes each provider needs.
 *
 * Google's defaults already carry the address and profile. GitHub needs
 * `user:email` before it will release a verified address, and Microsoft needs
 * `email` before the account has one at all. Supabase asks for nothing beyond
 * these, so the consent screen stays as small as the product needs.
 */
const PROVIDER_SCOPES: Record<OAuthProvider, string | undefined> = {
  google: undefined,
  github: "read:user user:email",
  microsoft: "email openid profile",
};

/**
 * Which credential signed this account in.
 *
 * Read from `identities`, which lists every credential on the user, and then
 * from `app_metadata.provider`, which is what a token minted by an older SDK
 * carries. Supabase calls Microsoft `azure`; the product calls it Microsoft,
 * because that is the word on the button the person pressed.
 */
function providerOf(user: User | null): AccountProvider {
  if (!user) return null;
  const providers = (user.identities ?? []).map((identity) => identity.provider);
  const primary = user.app_metadata?.provider as string | undefined;

  if (providers.includes("google") || primary === "google") return "google";
  if (providers.includes("github") || primary === "github") return "github";
  if (providers.includes("azure") || primary === "azure") return "microsoft";
  if (providers.includes("email") || primary === "email") return "email";
  return null;
}

/**
 * The provider's own idea of the person's name.
 *
 * Each provider puts it somewhere slightly different: Google sends `full_name`
 * and `name`, GitHub sends `user_name` and sometimes `full_name`, Microsoft sends
 * `name` or `preferred_username`. All of them are weaker than a name the person
 * typed here, which is why this is only ever a fallback.
 */
function providerNameOf(user: User | null): string | null {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ["name", "full_name", "display_name", "user_name", "preferred_username"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return normalizeName(value);
  }
  return null;
}

/**
 * The name to greet this account by before it has chosen one.
 *
 * The provider's name is preferred over the address, because "Rani" reads better
 * than "rani.k". When the provider supplied nothing at all, the local part of the
 * address is the only human-shaped thing available.
 */
export function displayNameFromUser(user: User | null): string | null {
  const fromProvider = providerNameOf(user);
  if (fromProvider) return fromProvider;
  const address = user?.email ?? "";
  const local = address.split("@")[0]?.trim();
  return local ? normalizeName(local) : null;
}

/**
 * The view of one Supabase user, shared with the email/password flow.
 *
 * Exported because `lib/emailAuth.ts` has to answer with exactly the shape the
 * rest of the interface already reads. A second implementation of this mapping
 * would be the kind of duplicate that drifts: one of the two would learn about
 * a new field and the other would silently keep reporting the old shape.
 */
export function accountViewOf(user: User | null): AccountView {
  const provider = providerOf(user);
  return viewFromUser({
    configured: true,
    signedIn: Boolean(user),
    id: user?.id ?? null,
    email: user?.email ?? null,
    name: displayNameFromUser(user),
    emailVerified: user
      ? provider !== "email" || Boolean(user.email_confirmed_at || user.confirmed_at)
      : false,
    provider,
  });
}

const viewOf = accountViewOf;

/** Where the OAuth round trip comes back to: the product, not the front door. */
function oauthReturnUrl(): string {
  if (typeof window === "undefined") return "";
  return `${window.location.origin}/chat`;
}

/**
 * Opens one of the three OAuth doors.
 *
 * The browser leaves for the provider and comes back to this origin, where the
 * Supabase client exchanges the returned code for a session. The promise
 * resolves once the navigation has been requested; the answer is reported by
 * `watchAccount` at the next mount, so the caller does not need separate wiring.
 *
 * A provider that is switched off is refused before the navigation, and the
 * thrown error carries Supabase's code so `describeLinkError` can name the
 * toggle in the dashboard.
 */
export async function signInWithProvider(provider: OAuthProvider): Promise<void> {
  const client = getSupabase();
  if (!client) throw unconfigured();
  const { error } = await client.auth.signInWithOAuth({
    provider: PROVIDER_IDS[provider],
    options: {
      redirectTo: oauthReturnUrl(),
      scopes: PROVIDER_SCOPES[provider],
    },
  });
  if (error) throw error;
}

/**
 * Ends the session on this browser.
 *
 * The account and everything under it stay exactly where they are; this browser
 * simply stops being it, and the sign-in screen comes back. The caller clears
 * the device-local name so the next account is not greeted by the previous
 * person's.
 */
// ── One account, several sign-in methods ────────────────────────────────────
//
// A second credential is attached to the account that is already signed in, not
// to a new one. That is the whole point: without this, someone who first used
// Google and later pressed GitHub on the sign-in screen gets a second account
// with none of their chats. Supabase stores each credential as an identity under
// the same `auth.users` row, and signing in with any of them resolves to that
// row.
//
// Linking is a full-page round trip through the provider, exactly like signing
// in. The pending provider is remembered for the length of that trip so the
// result — success, or a provider that belongs to another account — is reported
// in Settings rather than on a sign-in screen the person is not looking at.

const PENDING_LINK_KEY = "openmi.account.linking";
const LINK_NOTICE_KEY = "openmi.account.linkNotice";

function store(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // A browser that refuses session storage still links; it only loses the
    // sentence explaining the result.
  }
}

function take(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(key);
    if (value) window.sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

function drop(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to undo.
  }
}

/** The credentials attached to the signed-in account, in Supabase's order. */
export async function listSignInMethods(): Promise<SignInMethod[]> {
  const client = getSupabase();
  if (!client) return [];
  const { data, error } = await client.auth.getUserIdentities();
  if (error) throw error;
  return (data.identities ?? []).map((identity) => {
    const meta = (identity.identity_data ?? {}) as Record<string, unknown>;
    const email = typeof meta.email === "string" ? meta.email : null;
    return {
      id: identity.identity_id,
      provider: identity.provider,
      email,
    };
  });
}

/**
 * Attaches one more provider to the account signed in here.
 *
 * The browser leaves for the provider and comes back to this origin; the
 * returned session still belongs to the same user. A refusal can arrive before
 * the navigation (bad configuration) or on the way back (the credential already
 * belongs to somebody else), so both are handled — the second by
 * `consumeOAuthError`.
 */
export async function linkSignInMethod(provider: OAuthProvider): Promise<void> {
  const client = getSupabase();
  if (!client) throw unconfigured();
  store(PENDING_LINK_KEY, provider);
  const { error } = await client.auth.linkIdentity({
    provider: PROVIDER_IDS[provider],
    options: {
      redirectTo: oauthReturnUrl(),
      scopes: PROVIDER_SCOPES[provider],
    },
  });
  if (error) {
    drop(PENDING_LINK_KEY);
    throw error;
  }
}

/**
 * Removes one credential from the account.
 *
 * The identity is read fresh rather than carried in the interface state: an id
 * from a stale list must not be able to name somebody else's credential. Supabase
 * refuses the last remaining identity itself; the screen also hides the button
 * in that case, because a control that cannot work should not be offered.
 */
export async function unlinkSignInMethod(identityId: string): Promise<void> {
  const client = getSupabase();
  if (!client) throw unconfigured();
  const { data, error } = await client.auth.getUserIdentities();
  if (error) throw error;
  const identity = data.identities.find((candidate) => candidate.identity_id === identityId);
  if (!identity) {
    throw Object.assign(new Error("That sign-in method is no longer attached to this account."), {
      code: "identity_not_found",
    });
  }
  const { error: refused } = await client.auth.unlinkIdentity(identity);
  if (refused) throw refused;
}

/**
 * The outcome of a linking round trip, read once.
 *
 * Set by `consumeOAuthError` when the page loads after the provider. Taking it
 * rather than reading it means a success is announced once instead of every
 * time Settings is opened.
 */
export function takeLinkNotice(): string | null {
  return take(LINK_NOTICE_KEY);
}

export async function signOutAccount(): Promise<void> {
  const client = getSupabase();
  if (!client) throw unconfigured();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

/**
 * Reads the provider's refusal, if the last page load was a failed round trip.
 *
 * Supabase puts `error` and `error_description` in the query string when the
 * provider refuses. The parameters are removed from the address bar after they
 * are read, so a reload does not report the same failure for ever. Other query
 * parameters (such as the GitHub panel's `?github=`) are kept.
 */
export function consumeOAuthError(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const raw =
    url.searchParams.get("error_description") ??
    url.searchParams.get("error") ??
    readHashError(url.hash);
  const error = raw ? raw.replace(/\+/g, " ") : null;

  // A link attempt began in Settings, so its outcome belongs there. On success
  // the provider merely returns to the app with a session; only the remembered
  // attempt can tell that apart from an ordinary page load.
  const linking = take(PENDING_LINK_KEY);
  if (linking) {
    store(
      LINK_NOTICE_KEY,
      error
        ? describeLinkReturn(linking, error)
        : `${signInMethodLabel(linking)} is now a way to sign in to this account.`
    );
  }

  if (!error) return null;

  for (const key of ["error", "error_code", "error_description"]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  return error;
}

function readHashError(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  return params.get("error_description") ?? params.get("error");
}

// ── The zone the account registered in ──────────────────────────────────────

/** Accounts already asked in this page's lifetime, so a mount is one RPC. */
const timeZoneClaimed = new Set<string>();

/** The browser's IANA zone, when the runtime can actually format it. */
function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isSupportedTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Records the zone the account was registered in, once.
 *
 * `set_profile_timezone` keeps the first valid zone it is given: a later trip
 * or a different browser cannot move the account's midnight. The daily Dew
 * bucket in `deduct_dew()` reads the same column, so the browser and the ledger
 * agree on when the day ends.
 *
 * Best effort. Until the write lands — or on a deployment without the
 * migration — the server's default zone stands.
 */
async function claimAccountTimeZone(): Promise<void> {
  const client = getSupabase();
  const zone = browserTimeZone();
  if (!client || !zone) return;
  const { error } = await client.rpc("set_profile_timezone", { p_timezone: zone });
  if (error) throw error;
}

function reportTimeZone(user: User): void {
  if (timeZoneClaimed.has(user.id)) return;
  timeZoneClaimed.add(user.id);
  void claimAccountTimeZone().catch(() => {
    // A failure is not remembered, so the next mount tries again.
    timeZoneClaimed.delete(user.id);
  });
}

/**
 * Subscribes to the signed-in identity.
 *
 * `onAuthStateChange` reports the restored session, a completed OAuth round trip,
 * an email confirmation, a token refresh and a sign-out through the same
 * callback, which is what this needs: the moment the account is not the one it
 * was, the interface is told. `TOKEN_REFRESHED` is folded into the same answer
 * because nothing on screen changes when a token is renewed — only who is
 * signed in does.
 */
export function watchAccount(onChange: (view: AccountView) => void): () => void {
  const client = getSupabase();
  if (!client || typeof window === "undefined") {
    onChange({
      status: "unconfigured",
      id: null,
      email: null,
      name: null,
      signedIn: false,
      emailVerified: false,
      provider: null,
    });
    return () => {};
  }

  let cancelled = false;
  const report = (user: User | null) => {
    if (user) reportTimeZone(user);
    if (!cancelled) onChange(viewOf(user));
  };

  // The restored session is read first: the subscription below reports changes
  // from the moment it starts, and a returning visitor needs the answer now.
  void withTimeout(client.auth.getSession())
    .then(({ data }) => report(data.session?.user ?? null))
    .catch(() => {
      if (!cancelled) {
        onChange({
          status: "unreachable",
          id: null,
          email: null,
          name: null,
          signedIn: false,
          emailVerified: false,
          provider: null,
        });
      }
    });

  const { data } = client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") report(null);
    else report(session?.user ?? null);
  });

  return () => {
    cancelled = true;
    data.subscription.unsubscribe();
  };
}

function unconfigured(): Error & { code?: string } {
  return Object.assign(
    new Error("This deployment has no Supabase project configured, so accounts are unavailable."),
    { code: "auth/unconfigured" }
  );
}

// ── The name that follows the account ────────────────────────────────────────

/**
 * Records the name against the account.
 *
 * Two writes, both best effort. `profiles` is the readable copy the interface
 * loads on a new browser, and the auth metadata is what the provider-independent
 * fallbacks read before `profiles` has loaded. A failed write loses
 * cross-browser names, never the account.
 */
export async function saveAccountName(name: string | null | undefined): Promise<void> {
  const trimmed = normalizeName(name);
  if (!trimmed) return;
  const client = getSupabase();
  if (!client) return;
  const user = await currentUser();
  if (!user) return;

  try {
    await client.from("profiles").upsert(
      {
        id: user.id,
        name: trimmed,
        email: user.email ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
  } catch {
    // Offline, or the policies are not applied yet. The local name still stands.
  }

  try {
    await client.auth.updateUser({ data: { name: trimmed } });
  } catch {
    // The profile row is the copy other browsers read first.
  }
}

/**
 * Reads the name this account chose on another browser.
 *
 * `profiles` first, then the auth metadata. Returns null on any failure — so the
 * caller treats it as "no name to adopt" and keeps whatever this browser already
 * knows.
 */
export async function loadAccountName(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;
  const user = await currentUser();
  if (!user) return null;

  try {
    const { data, error } = await client
      .from("profiles")
      .select("name")
      .eq("id", user.id)
      .maybeSingle();
    if (!error) {
      const name = (data as { name?: unknown } | null)?.name;
      if (typeof name === "string" && normalizeName(name)) return normalizeName(name);
    }
  } catch {
    // Fall through to the metadata copy.
  }

  return providerNameOf(user);
}
