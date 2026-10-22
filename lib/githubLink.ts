// ── Connecting GitHub from the browser ──────────────────────────────────────
//
// Google stays the account. GitHub is attached to it the same way Google is:
// `linkWithPopup` adds a credential to the *existing* Firebase user, so the UID
// does not change, the history stays where it is, and the Dew wallet is the same
// wallet. A GitHub account that is already a Firebase user somewhere else is
// refused rather than signed into — quietly switching identity would move
// somebody's history without asking.
//
// The access token exists in this module for exactly one request. It is posted
// once to `/api/github/link`, which verifies it with GitHub and seals it; the
// browser keeps no copy the app depends on afterwards.
//
// "Not enabled" is the common failure and gets its own instruction: Firebase
// hosts the GitHub OAuth app, so the deployment owner has to turn the provider
// on in the console before any of this can work.

import { GithubAuthProvider, linkWithPopup } from "firebase/auth";
import { authHeader, firebaseConfigured, getServices } from "./firebaseHistory";

export type GithubLinkOutcome =
  | { status: "linked"; login: string }
  /** The person closed the popup, or it was blocked. Nothing is wrong. */
  | { status: "dismissed" }
  | { status: "error"; message: string };

const SETUP_MESSAGE =
  "GitHub sign-in is not available on this deployment. Either set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET (a GitHub OAuth App — no Firebase console change) or enable GitHub under Firebase console → Authentication → Sign-in method, then try again.";

function messageForCode(code: string): string {
  switch (code) {
    case "auth/operation-not-allowed":
      return SETUP_MESSAGE;
    case "auth/account-exists-with-different-credential":
    case "auth/credential-already-in-use":
      return "That GitHub account is already connected to another session. Sign in with that account, or connect a different GitHub account.";
    case "auth/unauthorized-domain":
      return "This domain is not authorised for sign-in. Add it in Firebase console → Authentication → Settings → Authorized domains.";
    case "auth/popup-blocked":
      return "The browser blocked the GitHub window. Allow popups for this site and try again.";
    case "auth/network-request-failed":
      return "Could not reach GitHub. Check the connection and try again.";
    case "auth/requires-recent-login":
      return "For security, sign in again before connecting GitHub.";
    default:
      return "GitHub could not be connected. Try again, or check the GitHub OAuth App and Firebase GitHub provider settings.";
  }
}

export function githubLinkDismissed(code: string): boolean {
  return code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request";
}

/**
 * Runs the link flow and stores the token server-side.
 *
 * Returns a discriminated result rather than throwing: the caller renders three
 * different things for linked, dismissed and failed, and an exception would
 * collapse the first two into the third.
 */
export async function linkGithubAccount(): Promise<GithubLinkOutcome> {
  if (!firebaseConfigured) {
    return { status: "error", message: "This deployment has no Firebase project configured, so it cannot store a GitHub connection." };
  }

  let accessToken = "";
  try {
    const services = await getServices();
    if (!services) {
      return { status: "error", message: "Accounts are not available on this deployment right now." };
    }
    const user = await services.ensureUser();
    const provider = new GithubAuthProvider();
    // `repo` is what reading a private repository and later committing to one
    // requires. It is the only scope asked for; anything else is not used.
    provider.addScope("repo");
    const result = await linkWithPopup(user, provider);
    accessToken = GithubAuthProvider.credentialFromResult(result)?.accessToken ?? "";
  } catch (cause) {
    const code = (cause as { code?: string })?.code ?? "";
    if (githubLinkDismissed(code)) return { status: "dismissed" };
    return { status: "error", message: messageForCode(code) };
  }

  if (!accessToken) {
    return { status: "error", message: "GitHub did not return an access token. Try connecting again." };
  }

  try {
    const response = await fetch("/api/github/link", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ accessToken }),
    });
    const payload = (await response.json().catch(() => null)) as { login?: string; error?: string } | null;
    if (!response.ok) {
      return { status: "error", message: payload?.error ?? `The connection could not be saved (HTTP ${response.status}).` };
    }
    return { status: "linked", login: payload?.login ?? "" };
  } catch {
    return { status: "error", message: "The connection could not be saved. Check the network and try again." };
  }
}
