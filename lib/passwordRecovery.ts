// Password recovery — change-password redirect.

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
