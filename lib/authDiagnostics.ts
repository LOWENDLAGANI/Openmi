// ── Why can this browser not get an account? ────────────────────────────────
//
// `anonymous_provider_disabled` is a poor clue, and a 401 from the auth server
// is worse. Both mean the same thing to the person reading them: nothing tells
// them which toggle to change, or which project the key belongs to.
//
// Supabase answers the question directly. `GET /auth/v1/settings` returns the
// provider switches for the project the key names — including whether anonymous
// sign-ins and email sign-ups are on — so this module asks it and prints the
// answer instead of guessing from an error code. The mapping from the settings
// to a fix is pure and tested; the request is one unauthenticated call and
// creates nothing, which is better than the old probe that signed a user in to
// find out whether signing in worked.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

export interface SignInDiagnosis {
  /** False when this build has no Supabase values at all. */
  configured: boolean;
  /** The project reference, which is the subdomain of the project URL. */
  projectId: string | null;
  /** The project URL's host, for comparing with the dashboard. */
  authDomain: string | null;
  /** The last four characters of the anon key, enough to compare with the console. */
  keyHint: string | null;
  /** The host the browser is actually running on, which must be allowed by CORS. */
  origin: string;
  /** True when the project accepts anonymous sign-ins, which this build needs. */
  ok: boolean;
  /** The auth server's own answer. Null when there was none. */
  backendMessage: string | null;
  verdict: string;
  nextStep: string;
}

/**
 * Turns the auth server's answer into the one thing to go and change.
 *
 * Pure, so the mapping can be asserted without a network or a project. Every
 * branch names a place in the dashboard rather than restating the error: the
 * code is not the useful part.
 */
export function explainSignInError(
  backendMessage: string | null,
  ok: boolean
): { verdict: string; nextStep: string } {
  if (ok) {
    return {
      verdict:
        "This project accepts anonymous sign-in. Account creation is not the problem on this deployment.",
      nextStep:
        "If a sign-in still fails, it is the method you are using — open the account form and note which message it shows.",
    };
  }

  const message = backendMessage ?? "";

  if (message === "ANONYMOUS_DISABLED") {
    return {
      verdict: "The Anonymous provider is switched off for this project.",
      nextStep:
        "Supabase dashboard → Authentication → Sign In / Providers → Anonymous sign-ins → Enable, then run the check again.",
    };
  }

  if (message === "SIGNUP_DISABLED") {
    return {
      verdict:
        "The project refuses new accounts, so a first-time visitor cannot be signed in as a guest.",
      nextStep:
        "Authentication → Sign In / Providers: turn on Allow new users to sign up, then run the check again.",
    };
  }

  if (message === "INVALID_API_KEY" || message === "HTTP_401" || message === "HTTP_403") {
    return {
      verdict:
        "The anon key in this build is not one this project accepts. The browser and the dashboard may be looking at two different projects.",
      nextStep:
        "Compare NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY against Supabase → Project Settings → API. These values are embedded at build time, so a rebuild is required after changing them.",
    };
  }

  if (message.startsWith("HTTP_")) {
    return {
      verdict: `The auth server answered ${message.slice(5)} instead of its settings.`,
      nextStep:
        "Check that NEXT_PUBLIC_SUPABASE_URL is the project URL — not the dashboard URL — and that the project is not paused.",
    };
  }

  if (!message) {
    return {
      verdict: "The probe could not reach Supabase at all.",
      nextStep:
        "Check the network (an extension or proxy may be blocking the project's host), then run the check again.",
    };
  }

  return {
    verdict: `Supabase answered: ${message}`,
    nextStep:
      "That message is the auth server's own words; it is more specific than the code the SDK showed.",
  };
}

/**
 * Asks the project for its auth settings.
 *
 * No session is needed and nothing is created. `disable_signup` and the
 * `external` map are the two things the verdict is built from.
 */
export async function diagnoseSignIn(): Promise<SignInDiagnosis> {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  })();

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const base: SignInDiagnosis = {
    configured: Boolean(url && anonKey),
    projectId: host ? host.split(".")[0] : null,
    authDomain: host,
    keyHint: anonKey ? `…${anonKey.slice(-4)}` : null,
    origin,
    ok: false,
    backendMessage: null,
    verdict: "",
    nextStep: "",
  };

  if (!base.configured) {
    return {
      ...base,
      verdict:
        "This build has no Supabase configuration, so the browser cannot reach any project — which is a deployment setting, not a dashboard one.",
      nextStep:
        "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then rebuild: these values are embedded at build time, so adding them to a running deployment changes nothing until it is rebuilt.",
    };
  }

  let ok = false;
  let backendMessage: string | null = null;

  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/settings`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      cache: "no-store",
    });
    if (response.ok) {
      const settings = (await response.json().catch(() => null)) as
        | { external?: Record<string, boolean>; disable_signup?: boolean }
        | null;
      ok = settings?.external?.anonymous === true;
      // Sign-ups being off is the more specific answer: a guest session cannot
      // exist at all if the project refuses to create the user behind it.
      backendMessage = ok ? null : settings?.disable_signup === true ? "SIGNUP_DISABLED" : "ANONYMOUS_DISABLED";
    } else {
      backendMessage = response.status === 401 || response.status === 403
        ? "INVALID_API_KEY"
        : `HTTP_${response.status}`;
    }
  } catch {
    backendMessage = null;
  }

  const explanation = explainSignInError(backendMessage, ok);
  return { ...base, ok, backendMessage, ...explanation };
}
