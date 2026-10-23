// ── The visitor's account ────────────────────────────────────────────────────
// Signing a Google account onto Openmi, detaching it, and carrying a name across
// browsers. This is the user's account and not the administrator's: nothing here
// can grant console access, and nothing here reads the console's data.
//
// The whole design rests on one Supabase behaviour. The app signs every
// first-time visitor in anonymously, and Supabase lets that same user be turned
// into a permanent one in place — `linkIdentity` attaches a Google identity to
// the *existing* user, so the UID does not change. That makes binding a
// migration rather than a copy: the chats already logged under that UID stay
// exactly where they are, and no chat is ever moved, duplicated, or re-uploaded.
// The same is true in the other direction — an account that already exists
// somewhere else is signed into rather than merged into, because merging two
// histories is the one operation here that could lose someone's words.
//
// Elevation is decided entirely by the policies in `supabase/migrations`, which
// compare one address seeded in `app_admin`. Signing in with Google grants a
// token and nothing else, so there is no path from this file to the admin
// console even for the person who owns it.
//
// ── Why the redirect ────────────────────────────────────────────────────────
// Supabase's OAuth is a full-page round trip rather than a popup. That is the
// shape most large sites use, and it removes a whole class of failure the popup
// path had: extensions, strict pop-up settings and embedded views that block
// `window.open` no longer matter. The intent is written to `sessionStorage`
// before the browser leaves, and `consumeGoogleSignIn` reads it at the next
// mount, so the caller is told what actually happened rather than what was
// attempted.

import type { User } from "@supabase/supabase-js";
import { ensureUser, getSupabase, withTimeout } from "./supabase";
import { isDismissed, normalizeName, type AccountProvider, type AccountView } from "./accountState";

/** What a bind actually did, which the interface needs to describe it honestly. */
export type BindOutcome =
  /** The anonymous user gained a Google identity. The UID never changed. */
  | "linked"
  /**
   * That Google account already had an Openmi history elsewhere, so Openmi
   * signed into it instead. The UID changed, and the caller must re-sync local
   * chats onto it.
   */
  | "adopted"
  /** The person closed the window. Nothing happened and nothing is wrong. */
  | "dismissed";

export interface BindResult {
  outcome: BindOutcome;
  view: AccountView;
}

/** Supabase marks a guest with this flag; older tokens are told apart by having
 *  no identities at all, which is what an anonymous user carries. */
export function isAnonymousUser(user: User | null): boolean {
  if (!user) return false;
  if (user.is_anonymous === true) return true;
  return Array.isArray(user.identities) && user.identities.length === 0;
}

/**
 * Which credential signed this account in.
 *
 * Read from `identities`, which lists every credential on the user. A guest has
 * none and answers null. Supabase names the email/password provider `email`,
 * which is not obvious enough to leave unexplained at the call site.
 */
function providerOf(user: User | null): AccountProvider {
  if (!user || isAnonymousUser(user)) return null;
  const providers = (user.identities ?? []).map((identity) => identity.provider);
  if (providers.includes("google")) return "google";
  if (providers.includes("email")) return "email";
  if (user.app_metadata?.provider === "google") return "google";
  if (user.app_metadata?.provider === "email") return "email";
  return null;
}

/**
 * The view of one Supabase user, shared with the email/password flow.
 *
 * Exported because `lib/emailAuth.ts` has to answer with exactly the shape the
 * rest of the interface already reads. A second implementation of this mapping
 * would be the kind of duplicate that drifts: one of the two would learn about
 * a new field and the other would silently keep reporting the old shape.
 *
 * `emailVerified` reads `email_confirmed_at`. A Google identity is confirmed by
 * Google, so it is only ever false for an email/password account that has not
 * clicked the link yet — and nothing is gated on it.
 */
export function accountViewOf(user: User | null): AccountView {
  const anonymous = isAnonymousUser(user);
  const linked = Boolean(user) && !anonymous;
  return {
    status: linked ? "linked" : "guest",
    email: linked ? user?.email ?? null : null,
    name: (user?.user_metadata?.name as string | undefined) ?? (user?.user_metadata?.display_name as string | undefined) ?? null,
    isLinked: linked,
    canBind: !linked,
    emailVerified: Boolean(user?.email_confirmed_at || user?.confirmed_at),
    provider: providerOf(user),
  };
}

const viewOf = accountViewOf;

/** Where the OAuth round trip comes back to. */
function oauthReturnUrl(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

/** What a pending round trip is trying to do, remembered across the redirect. */
type OAuthIntent = "link" | "signin";
const INTENT_KEY = "openmi:oauth-intent";

function markOAuthIntent(intent: OAuthIntent): void {
  try {
    window.sessionStorage.setItem(INTENT_KEY, intent);
  } catch {
    // A browser with storage blocked loses the intent, not the sign-in.
  }
}

function readOAuthIntent(): OAuthIntent | null {
  try {
    const value = window.sessionStorage.getItem(INTENT_KEY);
    return value === "link" || value === "signin" ? value : null;
  } catch {
    return null;
  }
}

function clearOAuthIntent(): void {
  try {
    window.sessionStorage.removeItem(INTENT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Attaches a Google account to whoever is using Openmi.
 *
 * A guest is upgraded in place and keeps their UID, so nothing they have written
 * moves: `linkIdentity` is handed the account already in use, and in-place
 * linking is what leaves the UID alone. A browser whose Google account is
 * already known to Openmi signs into that account instead, because a second copy
 * of the same person's history would be worse than none — the existing history
 * is the real one.
 *
 * The browser leaves for google.com and comes back; the answer is reported by
 * `consumeGoogleSignIn` at the next mount, so the caller does not need separate
 * wiring. The returned promise resolves with the intended shape because the
 * navigation usually beats it.
 */
export async function bindGoogleAccount(name?: string): Promise<BindResult> {
  const client = getSupabase();
  if (!client) throw unconfigured();
  const existing = await ensureUser();
  if (!existing) throw unconfigured();

  if (!isAnonymousUser(existing)) {
    await saveAccountName(name ?? null);
    return { outcome: "linked", view: viewOf(existing) };
  }

  await saveAccountName(name ?? null);

  // In-place linking needs "Manual linking" enabled in the project's auth
  // settings. When it is not, the refusal arrives here and before any
  // navigation, so the fallback below is a real fallback rather than a guess.
  markOAuthIntent("link");
  try {
    const link = await client.auth.linkIdentity({
      provider: "google",
      options: { redirectTo: oauthReturnUrl() },
    });
    if (!link.error) {
      // The browser is navigating to google.com. The shape is for the typing.
      return { outcome: "linked", view: viewOf(existing) };
    }
  } catch {
    // Fall through to the plain sign-in below.
  }

  const signIn = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: oauthReturnUrl() },
  });
  if (signIn.error) {
    clearOAuthIntent();
    throw signIn.error;
  }
  return { outcome: "adopted", view: viewOf(existing) };
}

/**
 * Returns this device to a name on its own.
 *
 * Signing out and back in anonymously is deliberate. Detaching the only identity
 * a user has would leave an account with no way back into it, so the session is
 * ended and a fresh guest identity takes its place; the history that belonged to
 * the old account stays with it and is waiting for the next browser that signs
 * into it.
 */
export async function detachGoogleAccount(): Promise<AccountView> {
  const client = getSupabase();
  if (!client) throw unconfigured();
  const user = await ensureUser();
  if (isAnonymousUser(user)) return viewOf(user);
  await client.auth.signOut();
  const next = await ensureUser();
  return viewOf(next);
}

/** Signs back into a Google account without touching the existing one first. */
export async function signInWithGoogle(name?: string): Promise<BindResult> {
  const client = getSupabase();
  if (!client) throw unconfigured();
  const existing = await ensureUser();
  await saveAccountName(name ?? null);

  markOAuthIntent("signin");
  const { error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: oauthReturnUrl() },
  });
  if (error) {
    clearOAuthIntent();
    throw error;
  }
  return {
    // The UID is only known after the round trip. Reporting "adopted" makes the
    // caller merge this device's chats onto whatever account comes back, which
    // is the safe direction: an extra union costs a write, a missed one costs
    // the person their history.
    outcome: "adopted",
    view: viewOf(existing),
  };
}

/**
 * Completes a Google sign-in that arrived as a page redirect.
 *
 * A full-page round trip can return while the component that started it is long
 * gone, so the outcome is consumed once here, at any mount. Nothing is lost by
 * calling it on every load: with no intent recorded this resolves immediately
 * with `completed: false`.
 *
 * The outcome carries whether the account is now linked — an anonymous user that
 * kept its UID through `linkIdentity` still owns everything it wrote — and the
 * raw error, so the caller can describe it in its own words.
 */
export interface GoogleRedirectResult {
  /** False when no redirect was in progress. */
  completed: boolean;
  outcome: BindOutcome | null;
  view: AccountView | null;
  /** The underlying auth error, for `describeLinkError`. */
  cause?: unknown;
}

export async function consumeGoogleSignIn(): Promise<GoogleRedirectResult> {
  if (typeof window === "undefined") return { completed: false, outcome: null, view: null };
  const intent = readOAuthIntent();
  if (!intent) return { completed: false, outcome: null, view: null };
  clearOAuthIntent();

  const client = getSupabase();
  if (!client) return { completed: false, outcome: null, view: null };

  // The OAuth error, when there is one, is put in the URL by the callback.
  const url = new URL(window.location.href);
  const callbackError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (callbackError) {
    return { completed: true, outcome: null, view: null, cause: new Error(callbackError) };
  }

  try {
    const { data } = await withTimeout(client.auth.getSession(), 10_000);
    const user = data.session?.user ?? null;
    if (!user) return { completed: true, outcome: null, view: null };
    if (isAnonymousUser(user)) return { completed: false, outcome: null, view: null };
    return {
      completed: true,
      outcome: intent === "link" ? "linked" : "adopted",
      view: viewOf(user),
    };
  } catch (cause: unknown) {
    if (isDismissed(cause)) return { completed: false, outcome: null, view: null };
    return { completed: true, outcome: null, view: null, cause };
  }
}

/**
 * Subscribes to the signed-in identity.
 *
 * `onAuthStateChange` reports the restored session, a link, a refresh and a
 * sign-out through the same callback, which is what this needs: the moment the
 * account is not the one it was, the interface is told. `TOKEN_REFRESHED` is
 * folded into the same answer because nothing on screen changes when a token is
 * renewed — only who is signed in does.
 */
export function watchAccount(onChange: (view: AccountView) => void): () => void {
  const client = getSupabase();
  if (!client || typeof window === "undefined") {
    onChange({
      status: "unconfigured",
      email: null,
      name: null,
      isLinked: false,
      canBind: false,
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
          email: null,
          name: null,
          isLinked: false,
          canBind: false,
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
 * Best effort by design: a failed write loses cross-browser names, never the
 * binding. The name itself is already saved locally, so nothing is lost by the
 * write failing — and an anonymous user has a `profiles` row like anyone else,
 * so a guest's name follows them the moment they sign in on another browser.
 */
export async function saveAccountName(name: string | null | undefined): Promise<void> {
  const trimmed = normalizeName(name);
  if (!trimmed) return;
  const client = getSupabase();
  if (!client) return;
  const user = await ensureUser();
  if (!user) return;
  try {
    await client
      .from("profiles")
      .upsert(
        { id: user.id, name: trimmed, email: user.email ?? null, updated_at: new Date().toISOString() },
        { onConflict: "id" }
      );
  } catch {
    // Offline, or the policies are not applied yet. The local name still stands.
  }
}

/**
 * Reads the name this account chose on another browser.
 *
 * Returns null on any failure — including a deployment whose migrations have not
 * been applied — so the caller treats it as "no name to adopt" and keeps
 * whatever this browser already knows.
 */
export async function loadAccountName(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;
  const user = await ensureUser();
  if (!user) return null;
  try {
    const { data, error } = await client
      .from("profiles")
      .select("name")
      .eq("id", user.id)
      .maybeSingle();
    if (error) return null;
    const name = (data as { name?: unknown } | null)?.name;
    return typeof name === "string" ? normalizeName(name) || null : null;
  } catch {
    return null;
  }
}
