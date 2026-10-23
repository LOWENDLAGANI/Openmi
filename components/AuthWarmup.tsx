"use client";

import { useEffect } from "react";
import { ensureUser } from "@/lib/supabase";

// ── Warm the account service before anyone can ask to sign in ────────────────
// The first identity call a browser makes is the expensive one: it reads the
// stored session, and for a first-time visitor it signs them in anonymously over
// the network. Left to the moment somebody presses a button, all of that stands
// between the tap and the next page, which reads as a slow or broken sign-in on a
// poor connection.
//
// So the session is established the moment any page mounts instead, and by the
// time a button is pressed the account already exists. `ensureUser()` is
// idempotent and signs a visitor in anonymously itself, so this is the whole
// warm-up; it also fails silently, because a deployment with no Supabase project
// has no account to warm and every caller already degrades when that is the case.
export default function AuthWarmup() {
  useEffect(() => {
    void ensureUser();
  }, []);
  return null;
}
