// ── Password recovery ────────────────────────────────────────────────────────
// The reset mail has to come back to a page that asks for a new password, not to
// the product. Supabase's guide calls this the change-password page, and using a
// dedicated path is what makes the intent survive the round trip: the session
// created by the recovery link lands there, the screen collects a new password,
// and only then does the person continue into Openmi.
//
// The path has to be listed in Supabase → Authentication → URL Configuration →
// Redirect URLs, for every origin. `recoveryRedirectUrl` builds it from the
// browser's own origin, so the deployed site and localhost each use their own.

/** Where the recovery mail returns. */
export const RECOVERY_PATH = "/auth/reset-password";

/** The absolute recovery URL for one origin. */
export function recoveryRedirectUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${RECOVERY_PATH}`;
}

/**
 * Why a proposed new password cannot be used, or null when it can.
 *
 * Supabase enforces its own minimum (six characters by default); this mirrors it
 * so the form answers before a round trip, and so the two fields are compared
 * here rather than by the server, which never sees the confirmation.
 */
export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < 6) return "Use at least six characters.";
  if (password !== confirmation) return "The two passwords do not match.";
  return null;
}
