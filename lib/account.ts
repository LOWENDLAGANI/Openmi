// The account — sign-in with Google, GitHub, Microsoft or email, sign-out, names.

import type { Provider, User } from "@supabase/supabase-js";
import { currentUser, getSupabase, withTimeout } from "./supabase";
import {
  describeAccount as viewFromUser,
  normalizeName,
  type AccountProvider,
  type AccountView,
} from "./accountState";

/** The three OAuth doors the interface offers. */
export type OAuthProvider = "google" | "github" | "microsoft";

/** Supabase's provider id for each door. Microsoft is `azure` in the dashboard. */
const PROVIDER_IDS: Record<OAuthProvider, Provider> = {
  google: "google",
  github: "github",
  microsoft: "azure",
};

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

/** Which credential signed this account in, from `identities`. */
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

/** Provider names from user_metadata — weaker than a name the person typed. */
function providerNameOf(user: User | null): string | null {
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ["name", "full_name", "display_name", "user_name", "preferred_username"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return normalizeName(value);
  }
  return null;
}

/** Name to greet this account by before it has chosen one. */
export function displayNameFromUser(user: User | null): string | null {
  const fromProvider = providerNameOf(user);
  if (fromProvider) return fromProvider;
  const address = user?.email ?? "";
  const local = address.split("@")[0]?.trim();
  return local ? normalizeName(local) : null;
}

/** The interface view of one Supabase user. */
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

/** Where the OAuth round trip comes back to. */
function oauthReturnUrl(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
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
  const error =
    url.searchParams.get("error_description") ??
    url.searchParams.get("error") ??
    readHashError(url.hash);
  if (!error) return null;

  for (const key of ["error", "error_code", "error_description"]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
  return error.replace(/\+/g, " ");
}

function readHashError(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  return params.get("error_description") ?? params.get("error");
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
