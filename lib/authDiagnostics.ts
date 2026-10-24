// Auth diagnostics — reports which project a build talks to and which doors it offers.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

/** The doors this build offers, in the order the sign-in screen shows them. */
export interface SignInMethods {
  google: boolean;
  github: boolean;
  microsoft: boolean;
  email: boolean;
}

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
  /** True when at least one of the four doors is open. */
  ok: boolean;
  /** The auth server's own answer. Null when there was none. */
  backendMessage: string | null;
  /** Which providers the project has switched on. */
  methods: SignInMethods;
  verdict: string;
  nextStep: string;
}

const NO_METHODS: SignInMethods = {
  google: false,
  github: false,
  microsoft: false,
  email: false,
};

function methodNames(methods: SignInMethods): string {
  const open = [
    methods.google ? "Google" : null,
    methods.github ? "GitHub" : null,
    methods.microsoft ? "Microsoft" : null,
    methods.email ? "email and password" : null,
  ].filter((name): name is string => Boolean(name));
  if (open.length === 0) return "none";
  if (open.length === 1) return open[0]!;
  return `${open.slice(0, -1).join(", ")} and ${open[open.length - 1]}`;
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
  ok: boolean,
  methods: SignInMethods = NO_METHODS
): { verdict: string; nextStep: string } {
  if (ok) {
    return {
      verdict: `This project accepts sign-in with ${methodNames(methods)}. The provider side is not the problem on this deployment.`,
      nextStep:
        "If a sign-in still fails, it is the method you picked — open the sign-in screen and note which message it shows.",
    };
  }

  const message = backendMessage ?? "";

  if (message === "NO_PROVIDERS") {
    return {
      verdict:
        "None of the four sign-in methods is switched on for this project, so nobody can create a session.",
      nextStep:
        "Supabase dashboard → Authentication → Sign In / Providers: turn on Google, GitHub, Azure (Microsoft) and Email, then run the check again.",
    };
  }

  if (message === "SIGNUP_DISABLED") {
    return {
      verdict:
        "The project refuses new accounts, so a first-time visitor cannot register.",
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
 * `external` map are the two things the verdict is built from. `azure` is
 * Supabase's name for the Microsoft door.
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
    methods: NO_METHODS,
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

  let methods = NO_METHODS;
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
      methods = {
        google: settings?.external?.google === true,
        github: settings?.external?.github === true,
        microsoft: settings?.external?.azure === true,
        email: settings?.external?.email === true,
      };
      ok = methods.google || methods.github || methods.microsoft || methods.email;
      backendMessage = ok
        ? null
        : settings?.disable_signup === true
          ? "SIGNUP_DISABLED"
          : "NO_PROVIDERS";
    } else {
      backendMessage = response.status === 401 || response.status === 403
        ? "INVALID_API_KEY"
        : `HTTP_${response.status}`;
    }
  } catch {
    backendMessage = null;
  }

  const explanation = explainSignInError(backendMessage, ok, methods);
  return { ...base, ok, backendMessage, methods, ...explanation };
}
