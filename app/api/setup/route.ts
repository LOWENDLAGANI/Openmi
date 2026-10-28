import { NextRequest } from "next/server";
import { checkRateLimit, rateLimitRefusal } from "@/lib/serverControl";
import { setupReport } from "@/lib/setupChecks";
import {
  SCHEMA_HEALTH_RPC,
  isMissingFunction,
  missingHealthFunction,
  summarizeSchemaHealth,
  unconfiguredSchemaHealth,
  unreadableSchemaHealth,
  type DatabaseHealth,
  type SchemaCheck,
} from "@/lib/schemaHealth";
import { publicClient, supabaseProjectUrl } from "@/lib/supabase";

// ── What this deployment is missing ──────────────────────────────────────────
// Read by the About page's setup banner, with no authentication and on
// purpose: the banner is what an owner looks at in the first five minutes of a
// deployment, before any account exists, so gating it would hide exactly the
// person who needs it.
//
// Two questions, answered together:
//   1. Are the environment keys present? (lib/setupChecks.ts — presence only.)
//   2. Was the schema actually migrated? (`openmi_schema_health()` — existence
//      of tables, columns and functions, never a row.)
//
// Both answers are lists of facts, never values. That is what makes this safe
// on a public page, and it is why a failing database does not make the endpoint
// throw: a report that cannot be obtained is still worth showing.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which Supabase project this server is actually bound to.
 *
 * The single most expensive ambiguity in this deployment: the browser bundle
 * inlines `NEXT_PUBLIC_SUPABASE_URL` at build time while this process reads it
 * at request time, so a rebuild that was forgotten — or a migration applied to
 * the project in the dashboard tab instead of the one the build embeds — leaves
 * two databases in play. The symptom is a ledger that never moves while the
 * schema health page says everything is present, because it is present *there*.
 *
 * Printing the host is safe: the same URL is already in the client bundle, and
 * the anon key identifies the project anyway. It is the one fact needed to
 * compare this deployment against the project someone just migrated.
 */
function boundProject(): { host: string; ref: string } | null {
  const raw = supabaseProjectUrl.trim();
  if (!raw) return null;
  try {
    const host = new URL(raw).host;
    // A Supabase project URL is https://<ref>.supabase.co; a custom domain in
    // front of it has no ref to show, so the whole host is the answer.
    return { host, ref: host.split(".")[0] ?? host };
  } catch {
    return null;
  }
}

/** Runs the schema audit, or explains why it could not run. */
async function databaseHealth(): Promise<DatabaseHealth> {
  const client = publicClient();
  if (!client) return unconfiguredSchemaHealth();

  try {
    const { data, error } = await client.rpc(SCHEMA_HEALTH_RPC);
    if (error) {
      if (isMissingFunction(error)) return missingHealthFunction();
      return unreadableSchemaHealth(error.message || "The database refused the schema check.");
    }
    return summarizeSchemaHealth((data ?? []) as SchemaCheck[]);
  } catch (cause) {
    return unreadableSchemaHealth(
      cause instanceof Error ? cause.message : "The schema check could not reach the database."
    );
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  // Public and therefore unlimited by identity: the bucket is per address.
  // The endpoint does real work (an RPC against the database), so it needs a
  // ceiling even though it asks no one to sign in.
  const limit = await checkRateLimit(req, null, "setup");
  if (!limit.allowed) return rateLimitRefusal(limit);

  const database = await databaseHealth();
  return Response.json(
    // `project` is the database this server charges against; the browser's own
    // answer is on Settings → Account → "Why can't I sign in?". If those two
    // refs differ, the deployment is stale and no SQL change will help until
    // it is rebuilt.
    { ...setupReport(), database, project: boundProject() },
    { headers: { "cache-control": "no-store" } }
  );
}
