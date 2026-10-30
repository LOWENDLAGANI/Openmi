// ── The Supabase project, from the browser ──────────────────────────────────
//
// One client for the whole tab. It holds the session (persisted, refreshed) and
// it is the thing every authenticated read and write goes through, so the
// database sees the caller's own JWT and Postgres row-level security is the only
// judge. Every route builds its client from the caller's own token.
//
// The one exception is deliberate and narrow: `lib/supabaseAdmin.ts` holds the
// deployment's service-role key, and only the `/api/agent/runs` routes import it
// — creating or advancing a run is the one job with no caller to act as. Nothing
// else may use that module.
//
// ── Accounts are required ───────────────────────────────────────────────────
// Openmi no longer creates anonymous visitors. A browser has either signed in
// with Google, GitHub, Microsoft or an email address and password, or it has no
// session at all and the interface shows the sign-in screen. Nothing in this
// module ever mints an identity: `currentUser` reads the stored session, so a
// signed-out browser answers null and the gate decides what to render.
//
// ── Why the timeouts ────────────────────────────────────────────────────────
// `getSession` is an ordinary network await when the stored session needs
// refreshing. It resolves in milliseconds on a healthy connection, and never
// resolves at all when a captive portal or a company SSL box is holding the
// connection open. Every await below that answers "who is this?" is bounded, and
// a missing answer degrades to "nobody yet" rather than to a spinner.

import {
  createClient,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

/** True when this deployment has a Supabase project configured at all. */
export const supabaseConfigured = Boolean(url && anonKey);

/** The project address, for the few places that need it as a value. */
export const supabaseProjectUrl = url;

/** The most the first question about identity may hold the app hostage. */
const FIRST_ANSWER_TIMEOUT_MS = 8_000;

/** Rejects after `milliseconds` instead of waiting for ever. */
export function withTimeout<T>(promise: Promise<T>, milliseconds = FIRST_ANSWER_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${milliseconds}ms`)),
      milliseconds
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

let browserClient: SupabaseClient | null = null;

/**
 * The client for this browser, or null when the deployment is unconfigured.
 *
 * Created once. Supabase's client owns the session, the refresh timer and the
 * realtime socket; a second instance would be a second session, which is how two
 * copies of a signed-in app end up disagreeing about who is using it.
 *
 * PKCE is what the OAuth and email-confirmation redirects come back through.
 * With `detectSessionInUrl` on, the client exchanges the code the provider put
 * in the URL for a session on creation, so the sign-in completes as soon as any
 * page mounts — there is no callback route to maintain.
 */
export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  if (!browserClient) {
    browserClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    });
  }
  return browserClient;
}

/**
 * The signed-in user, restoring the stored session but never creating one.
 *
 * Null covers three cases the callers already handle the same way, because for
 * all three there is simply no identity to attach to a request: no project
 * configured, no browser (a server render), and nobody signed in.
 */
export async function currentUser(): Promise<User | null> {
  const client = getSupabase();
  if (!client || typeof window === "undefined") return null;
  try {
    const session = await withTimeout(client.auth.getSession());
    return session.data.session?.user ?? null;
  } catch {
    return null;
  }
}

/** The authorization headers for a call to one of this app's own routes. */
export async function authHeader(): Promise<Record<string, string>> {
  const client = getSupabase();
  if (!client) return {};
  try {
    const session = await withTimeout(client.auth.getSession());
    const token = session.data.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/**
 * A second client bound to one user's token, for the server routes.
 *
 * A fresh instance per request, never shared: a server process serves many
 * callers, and a cached client would serve one caller's rows to the next. The
 * anon key is the `apikey` header — it identifies the project, not the person —
 * while the caller's JWT is what PostgREST decodes into `auth.uid()`.
 *
 * Lives here rather than in the server-only module because `authHeader`'s
 * counterpart belongs beside it, and because both halves of the app are talking
 * to the same project.
 */
export function clientForToken(accessToken: string): SupabaseClient | null {
  if (!supabaseConfigured || !accessToken) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    db: { schema: "public" },
  });
}

/** The unauthenticated client, for the one public read (the runtime config). */
export function publicClient(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: "public" },
  });
}
