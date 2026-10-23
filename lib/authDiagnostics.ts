// ── Why can this browser not get an account? ────────────────────────────────
//
// `auth/admin-restricted-operation` is a poor clue. The SDK collapses several
// backend answers into it, and the answer is the only part that matters: the
// same sentence comes back when account creation is switched off, when the
// Anonymous provider is disabled, when the API key belongs to a different
// project, and when Identity Toolkit is not configured for the project id at
// all. People then go and enable the wrong toggle, or the right toggle in the
// wrong project.
//
// So this module asks the backend directly, with the same key the app uses, and
// keeps the raw `ADMIN_ONLY_OPERATION` / `OPERATION_NOT_ALLOWED` /
// `API_KEY_INVALID` string rather than letting the SDK flatten it. The mapping
// from that string to a fix is pure and tested; the request is one call to the
// same endpoint the SDK would use to sign a visitor in anonymously.
//
// It creates an anonymous user when it succeeds — which is exactly what the app
// does on every load, so the check costs nothing that was not already spent.

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() ?? "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim() ?? "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ?? "",
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL?.trim() ?? "",
};

export interface SignInDiagnosis {
  /** False when this build has no Firebase values at all. */
  configured: boolean;
  projectId: string | null;
  authDomain: string | null;
  /** The last four characters of the key, enough to compare with the console. */
  keyHint: string | null;
  /** The host the browser is actually running on, which must be authorised. */
  origin: string;
  /** True when the probe created an anonymous account. */
  ok: boolean;
  /** The backend's own words, e.g. `ADMIN_ONLY_OPERATION`. Null on success. */
  backendMessage: string | null;
  verdict: string;
  nextStep: string;
}

/**
 * Turns the backend's message into the one thing to go and change.
 *
 * Pure, so the mapping can be asserted without a network or a project. Every
 * branch names a place in the console rather than restating the error: the code
 * is not the useful part.
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

  if (message === "ADMIN_ONLY_OPERATION") {
    return {
      verdict:
        "The backend reports that account creation is restricted — either \"Enable create (sign-up)\" is off, or the Anonymous provider is off for this project.",
      nextStep:
        "Authentication → Settings → User Actions: tick Enable create (sign-up). Then Authentication → Sign-in method: enable Anonymous. Save both, reload this page, and run the check again.",
    };
  }

  if (message === "OPERATION_NOT_ALLOWED") {
    return {
      verdict: "The Anonymous provider is switched off for this project.",
      nextStep: "Authentication → Sign-in method → Anonymous → Enable, then run the check again.",
    };
  }

  if (message === "API_KEY_INVALID" || /api key not valid/i.test(message)) {
    return {
      verdict:
        "The API key in this build is not one this project accepts. The browser and the console may be looking at two different projects.",
      nextStep:
        "Compare NEXT_PUBLIC_FIREBASE_PROJECT_ID and the key against Firebase → Project settings → Your apps → Web app → SDK setup and configuration.",
    };
  }

  if (message === "CONFIGURATION_NOT_FOUND") {
    return {
      verdict: "Identity Toolkit is not configured for the project id in this build.",
      nextStep:
        "Check that NEXT_PUBLIC_FIREBASE_PROJECT_ID is the console project's id — not its display name — and rebuild.",
    };
  }

  if (message === "PERMISSION_DENIED") {
    return {
      verdict: "The request reached Google but was refused for this API key.",
      nextStep:
        "In Google Cloud console → APIs & Services → Credentials, check the key's HTTP-referrer restrictions include this origin, and that Identity Toolkit API is enabled.",
    };
  }

  if (!message) {
    return {
      verdict: "The probe could not reach Firebase at all.",
      nextStep:
        "Check the network (an extension or proxy may be blocking googleapis.com), then run the check again.",
    };
  }

  return {
    verdict: `Firebase answered: ${message}`,
    nextStep:
      "That message is the backend's own words; it is more specific than the code the SDK showed.",
  };
}

/**
 * Asks the backend directly, using the same key and endpoint the app's
 * anonymous sign-in uses.
 */
export async function diagnoseSignIn(): Promise<SignInDiagnosis> {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const base: SignInDiagnosis = {
    configured: Boolean(config.apiKey && config.projectId),
    projectId: config.projectId || null,
    authDomain: config.authDomain || null,
    keyHint: config.apiKey ? `…${config.apiKey.slice(-4)}` : null,
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
        "This build has no Firebase configuration, so the browser cannot reach any project — which is a deployment setting, not a console one.",
      nextStep:
        "Set NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID and the rest, then rebuild: these values are embedded at build time, so adding them to a running deployment changes nothing until it is rebuilt.",
    };
  }

  let ok = false;
  let backendMessage: string | null = null;

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
      }
    );
    if (response.ok) {
      ok = true;
    } else {
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      backendMessage = payload?.error?.message ?? `HTTP_${response.status}`;
    }
  } catch {
    backendMessage = null;
  }

  const explanation = explainSignInError(backendMessage, ok);
  return { ...base, ok, backendMessage, ...explanation };
}
