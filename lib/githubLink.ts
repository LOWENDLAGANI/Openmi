// GitHub connection from the browser — a stored credential, not a sign-in method.

import { authHeader, currentUser, supabaseConfigured } from "./supabase";

export type GithubLinkOutcome =
  /** The browser is leaving for github.com; the callback finishes the job. */
  | { status: "redirected" }
  /** The person closed the window, or it was blocked. Nothing is wrong. */
  | { status: "dismissed" }
  | { status: "error"; message: string };

const SETUP_MESSAGE =
  "GitHub sign-in is not available on this deployment. Either set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (a GitHub OAuth App) and connect from the repository panel, or paste a personal access token there instead.";

/**
 * Begins the GitHub round trip and returns once the browser is navigating.
 *
 * The start route is a POST rather than a redirect route for one reason:
 * identity. A redirect cannot carry the Authorization header, and without the
 * verified uid the callback would have no account to attach the result to. So
 * the URL is fetched here and the navigation is done on purpose.
 */
export async function linkGithubAccount(): Promise<GithubLinkOutcome> {
  if (!supabaseConfigured) {
    return {
      status: "error",
      message: "This deployment has no Supabase project configured, so it cannot store a GitHub connection.",
    };
  }

  const user = await currentUser();
  if (!user) {
    return { status: "error", message: "Accounts are not available on this deployment right now." };
  }

  try {
    const response = await fetch("/api/github/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ next: "/" }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { url?: string; error?: string; detail?: string }
      | null;

    if (response.status === 503 || payload?.detail === "not-configured") {
      return { status: "error", message: payload?.error ?? SETUP_MESSAGE };
    }
    if (response.status === 401) {
      return { status: "error", message: payload?.error ?? "Sign in before connecting GitHub." };
    }
    if (!response.ok || !payload?.url) {
      return {
        status: "error",
        message: payload?.error ?? `The GitHub connection could not be started (HTTP ${response.status}).`,
      };
    }

    // A full-page navigation, not a popup: popups are blocked often enough that
    // a connect button which depends on one reads as broken.
    window.location.assign(payload.url);
    return { status: "redirected" };
  } catch {
    return { status: "error", message: "Could not reach GitHub. Check the network and try again." };
  }
}
