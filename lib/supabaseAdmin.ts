// ── The one privileged client (server only) ──────────────────────────────────
//
// This module exists for exactly one job: a repository run that continues after
// the browser is gone. Every other read and write in Openmi goes through the
// caller's own JWT, so Postgres row-level security is the only judge
// (`lib/supabase.ts`). A tick has no caller — that is the whole point of it —
// so it needs an identity of its own, and this is it.
//
// Three rules keep that from becoming a hole in the rest of the app:
//
//   1. **Imported only by the run routes.** Grep for `supabaseAdmin` and every
//      hit is `app/api/agent/tick` or `app/api/agent/runs` — creating a run and
//      advancing one, the two jobs with no caller to act as. Both take the owner
//      from the verified session (`identity.uid`), never from the body: a route
//      that holds this key and trusts a caller-supplied id is a cross-account
//      read by construction.
//   2. **The rows it touches are named, never enumerated.** It reads and writes
//      `agent_runs` and inserts a `changesets` row that a run produced; it does
//      not browse.
//   3. **What it carries is sealed anyway.** The GitHub token and the account's
//      provider keys travel inside `agent_runs.state`, sealed with the same
//      AES-256-GCM key that protects them at rest. This key is a door, not a
//      reason to leave the safe open.
//
// `SUPABASE_SERVICE_ROLE_KEY` is unset on most deployments, and that is a
// supported state: with no key there are no background runs, and the agent keeps
// working the way it did before — driven by the tab that started it.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

/** True when this deployment can run a turn without a browser attached. */
export function runStoreConfigured(): boolean {
  return Boolean(url && serviceKey);
}

// Cached on purpose, unlike the per-caller clients in lib/supabase.ts: this key
// identifies the deployment rather than a person, so there is no session to leak
// between callers, and one socket per process is the cheaper choice.
let admin: SupabaseClient | null = null;

/** The service-role client, or null when the deployment has no key. */
export function supabaseAdmin(): SupabaseClient | null {
  if (!runStoreConfigured()) return null;
  if (!admin) {
    admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { schema: "public" },
    });
  }
  return admin;
}
