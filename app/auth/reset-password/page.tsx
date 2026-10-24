import type { Metadata } from "next";
import PasswordRecoveryScreen from "@/components/PasswordRecoveryScreen";

// ── The change-password page Supabase redirects to ───────────────────────────
// It has to be reachable without a session: the whole point is that the recovery
// mail creates one here. The screen itself explains an expired or misused link
// rather than leaving a blank page.

export const metadata: Metadata = {
  title: "Set a new password — Openmi",
  // A one-time recovery URL has no business in a search index.
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <PasswordRecoveryScreen />;
}
