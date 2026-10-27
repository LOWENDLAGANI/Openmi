// ── Is the database the schema this build expects? ───────────────────────────
//
// The environment checklist in setupChecks.ts answers "is this deployment
// configured?". It cannot answer "were the migrations actually applied?" — and
// that is the failure a fresh deployment hits first: the keys are present, the
// site renders, then every privileged call returns PGRST202 or PGRST204 and the
// owner is left reading a PostgREST code.
//
// This module is the second half of that answer. `openmi_schema_health()` (in
// 20261024000400_schema_health.sql) reports whether each required table, column
// and function exists. The endpoint turns the report into the one thing worth
// acting on: the missing migration, named.
//
// The check itself is deliberately public and presence-only. It says a table is
// missing, never what is inside one; an anonymous visitor learns nothing they
// could not learn by pressing the admin prompt and reading its error.

export type SchemaObjectKind = "table" | "column" | "function";

/** One row of `openmi_schema_health()`. */
export interface SchemaCheck {
  /** `profiles`, `profiles.timezone`, `deduct_dew(numeric)`, … */
  object_name: string;
  kind: SchemaObjectKind;
  present: boolean;
  /** The migration filename stem that creates it. */
  migration: string;
}

export interface SchemaGap {
  /** The migration to apply, e.g. `20261024000300_dew_timezone`. */
  migration: string;
  /** Everything that migration was supposed to add and did not. */
  objects: string[];
}

export interface DatabaseHealth {
  /** False when the project has no Supabase configuration at all. */
  checked: boolean;
  /** False when the health function itself could not answer. */
  reachable: boolean;
  /** How many objects were checked. */
  checkedObjects: number;
  /** Missing objects grouped by the migration that creates them. */
  missing: SchemaGap[];
  /** A readable reason when the answer could not be obtained. */
  message: string | null;
}

/**
 * The migration that adds the health function itself.
 *
 * If that function is missing, calling it raises PGRST202 and the only useful
 * answer is "apply this migration". Keeping the name here means the banner can
 * say so without a second round trip to learn what was missing.
 */
export const SCHEMA_HEALTH_MIGRATION = "20261024000400_schema_health";

/** The one public RPC that can answer without an account. */
export const SCHEMA_HEALTH_RPC = "openmi_schema_health";

/**
 * Turns the audit rows into the report the banner shows.
 *
 * Missing objects are grouped by migration rather than listed one per line: an
 * owner fixes migrations, not tables. The order is stable so a repeated check
 * does not reshuffle the list under the reader.
 */
export function summarizeSchemaHealth(rows: SchemaCheck[]): DatabaseHealth {
  const missingByMigration = new Map<string, string[]>();
  let checkedObjects = 0;
  for (const row of rows) {
    if (typeof row?.object_name !== "string" || typeof row?.migration !== "string") continue;
    checkedObjects += 1;
    if (row.present) continue;
    const objects = missingByMigration.get(row.migration) ?? [];
    objects.push(row.object_name);
    missingByMigration.set(row.migration, objects);
  }
  const missing = [...missingByMigration.entries()]
    .map(([migration, objects]) => ({ migration, objects: objects.sort() }))
    .sort((a, b) => a.migration.localeCompare(b.migration));
  return {
    checked: true,
    reachable: true,
    checkedObjects,
    missing,
    message: null,
  };
}

/** The report when the audit could not run, with the reason kept readable. */
export function unreadableSchemaHealth(message: string): DatabaseHealth {
  return {
    checked: true,
    reachable: false,
    checkedObjects: 0,
    missing: [],
    message,
  };
}

/**
 * The answer for a call that failed because the function is not there yet.
 *
 * PGRST202 is PostgREST's "no such function in the schema cache". It is not an
 * outage: it is the first migration of this feature. The banner should say that
 * rather than "database unreachable".
 */
export function missingHealthFunction(): DatabaseHealth {
  return {
    checked: true,
    reachable: true,
    checkedObjects: 0,
    missing: [{ migration: SCHEMA_HEALTH_MIGRATION, objects: [SCHEMA_HEALTH_RPC] }],
    message: null,
  };
}

/** True when the error is PostgREST reporting an unknown function. */
export function isMissingFunction(cause: unknown): boolean {
  const error = cause as { code?: unknown } | null;
  return error?.code === "PGRST202";
}

/** The public report for a deployment with no Supabase project at all. */
export function unconfiguredSchemaHealth(): DatabaseHealth {
  return {
    checked: false,
    reachable: false,
    checkedObjects: 0,
    missing: [],
    message: null,
  };
}
