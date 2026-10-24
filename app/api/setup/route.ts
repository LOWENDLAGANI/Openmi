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
import { publicClient } from "@/lib/supabase";

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

export async function GET(): Promise<Response> {
  const database = await databaseHealth();
  return Response.json(
    { ...setupReport(), database },
    { headers: { "cache-control": "no-store" } }
  );
}
