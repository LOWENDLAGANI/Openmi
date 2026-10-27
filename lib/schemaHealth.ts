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
// ── Why the build carries its own copy of the list ───────────────────────────
// The database's audit reads `schema_expected`, a table the migrations insert
// their own objects into. A migration that never ran therefore never registers
// its own absence: the audit answers "42 objects checked, none missing" for a
// database that is three migrations behind, while every project read fails
// PGRST204 on `projects.commit_destination` and the panel says "That project is
// not attached to this account." for a row that exists. EXPECTED_SCHEMA below
// is this build's own copy of every registration the migrations make, so the
// report can name a migration precisely when the database has never heard of
// it. A row the database does return wins — presence is still the catalog's
// answer, never ours. tests/setup-check.test.ts parses supabase/migrations and
// fails if the two lists ever disagree, so this copy cannot drift.
//
// The check itself is deliberately public and presence-only. It says a table is
// missing, never what is inside one; an anonymous visitor learns nothing they
// could not learn by pressing the admin prompt and reading its error.

export type SchemaObjectKind = "table" | "view" | "column" | "function";

/** One row of `openmi_schema_health()`. */
export interface SchemaCheck {
  /** `profiles`, `profiles.timezone`, `deduct_dew(numeric)`, … */
  object_name: string;
  kind: SchemaObjectKind;
  present: boolean;
  /** The migration filename stem that creates it. */
  migration: string;
}

/** One object the build needs from the database, before any database is asked. */
export interface ExpectedSchemaObject {
  object_name: string;
  kind: SchemaObjectKind;
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
  checkedObjects: number;
  /** Missing objects grouped by the migration that creates them. */
  missing: SchemaGap[];
  /** A readable reason when the answer could not be obtained. */
  message: string | null;
}

/**
 * Every object the migrations register, held by the build rather than by the
 * database.
 *
 * The database's own list only knows about migrations that have run; this one
 * also knows about the ones that have not, which is the difference between an
 * audit that says "nothing missing" and one that names the three files still to
 * push. `20261031000000_schema_expected_backfill` registers the six objects
 * that earlier migrations created but never listed, attributed to itself
 * because its own insert is what makes the registration true.
 */
export const EXPECTED_SCHEMA: readonly ExpectedSchemaObject[] = [
  { object_name: "app_admin", kind: "table", migration: "20261023000000_init" },
  { object_name: "app_config", kind: "table", migration: "20261023000000_init" },
  { object_name: "is_admin()", kind: "function", migration: "20261023000000_init" },
  { object_name: "profiles", kind: "table", migration: "20261023000100_identity" },
  { object_name: "visitor_registry", kind: "table", migration: "20261023000100_identity" },
  { object_name: "push_subscriptions", kind: "table", migration: "20261023000100_identity" },
  {
    object_name: "register_visitor(text,timestamptz)",
    kind: "function",
    migration: "20261023000100_identity",
  },
  { object_name: "bump_usage(text,text)", kind: "function", migration: "20261023000100_identity" },
  { object_name: "admin_user_stats()", kind: "function", migration: "20261023000100_identity" },
  { object_name: "chats", kind: "table", migration: "20261023000200_chats" },
  { object_name: "chat_messages", kind: "table", migration: "20261023000200_chats" },
  { object_name: "memories", kind: "table", migration: "20261023000200_chats" },
  { object_name: "github_connections", kind: "table", migration: "20261023000300_github_projects" },
  { object_name: "projects", kind: "table", migration: "20261023000300_github_projects" },
  { object_name: "changesets", kind: "table", migration: "20261023000400_changesets" },
  { object_name: "approvals", kind: "table", migration: "20261023000400_changesets" },
  { object_name: "commits", kind: "table", migration: "20261023000400_changesets" },
  { object_name: "redeem_codes", kind: "table", migration: "20261023000500_dew_redeem" },
  { object_name: "redeems", kind: "table", migration: "20261023000500_dew_redeem" },
  { object_name: "dew_credits", kind: "table", migration: "20261023000500_dew_redeem" },
  { object_name: "dew_wallets", kind: "table", migration: "20261023000500_dew_redeem" },
  { object_name: "dew_transactions", kind: "table", migration: "20261023000500_dew_redeem" },
  { object_name: "deduct_dew(numeric)", kind: "function", migration: "20261023000500_dew_redeem" },
  {
    object_name: "lookup_redeem_code(text)",
    kind: "function",
    migration: "20261023000500_dew_redeem",
  },
  {
    object_name: "user_preferences",
    kind: "table",
    migration: "20261024000000_user_preferences",
  },
  { object_name: "folders", kind: "table", migration: "20261024000100_folders_trash" },
  { object_name: "trash", kind: "table", migration: "20261024000100_folders_trash" },
  { object_name: "chats.folder_id", kind: "column", migration: "20261024000100_folders_trash" },
  { object_name: "dew_wallets.daily_day", kind: "column", migration: "20261024000200_daily_dew" },
  { object_name: "dew_wallets.daily_spent", kind: "column", migration: "20261024000200_daily_dew" },
  { object_name: "profiles.timezone", kind: "column", migration: "20261024000300_dew_timezone" },
  {
    object_name: "set_profile_timezone(text)",
    kind: "function",
    migration: "20261024000300_dew_timezone",
  },
  {
    object_name: "dew_transactions.free_dew",
    kind: "column",
    migration: "20261024000500_dew_activity",
  },
  {
    object_name: "dew_transactions.paid_dew",
    kind: "column",
    migration: "20261024000500_dew_activity",
  },
  {
    object_name: "deduct_dew_split(numeric)",
    kind: "function",
    migration: "20261024000500_dew_activity",
  },
  { object_name: "referral_codes", kind: "table", migration: "20261024000600_referrals" },
  { object_name: "referrals", kind: "table", migration: "20261024000600_referrals" },
  { object_name: "ensure_referral_code()", kind: "function", migration: "20261024000600_referrals" },
  { object_name: "claim_referral(text)", kind: "function", migration: "20261024000600_referrals" },
  { object_name: "schema_expected", kind: "table", migration: "20261024000600_referrals" },
  { object_name: "shared_chats", kind: "table", migration: "20261024000700_shares" },
  { object_name: "shared_public", kind: "view", migration: "20261024000700_shares" },
  { object_name: "provider_keys", kind: "table", migration: "20261026000000_provider_keys" },
  { object_name: "paid_passes", kind: "table", migration: "20261028000000_pricing_sessions" },
  { object_name: "has_paid_pass()", kind: "function", migration: "20261028000000_pricing_sessions" },
  { object_name: "hour_sessions", kind: "table", migration: "20261028000000_pricing_sessions" },
  {
    object_name: "start_hour_session(text)",
    kind: "function",
    migration: "20261028000000_pricing_sessions",
  },
  {
    object_name: "end_hour_session()",
    kind: "function",
    migration: "20261028000000_pricing_sessions",
  },
  {
    object_name: "admin_grant_plan(uuid,integer)",
    kind: "function",
    migration: "20261028000000_pricing_sessions",
  },
  {
    object_name: "projects.commit_destination",
    kind: "column",
    migration: "20261030000000_commit_destination",
  },
  {
    object_name: "commits.destination",
    kind: "column",
    migration: "20261030000000_commit_destination",
  },
  { object_name: "usage_daily", kind: "table", migration: "20261031000000_schema_expected_backfill" },
  {
    object_name: "forget_visitor()",
    kind: "function",
    migration: "20261031000000_schema_expected_backfill",
  },
  { object_name: "github_links", kind: "table", migration: "20261031000000_schema_expected_backfill" },
  { object_name: "github_default", kind: "table", migration: "20261031000000_schema_expected_backfill" },
  { object_name: "admin_audit", kind: "table", migration: "20261031000000_schema_expected_backfill" },
  { object_name: "chat_jobs", kind: "table", migration: "20261031000000_schema_expected_backfill" },
];

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
 * Turns the audit rows — plus the build's own expected list — into the report
 * the banner shows.
 *
 * Missing objects are grouped by migration rather than listed one per line:
 * an owner fixes migrations, not tables. The order is stable so a repeated
 * check does not reshuffle the list under the reader.
 *
 * The merge is the point of EXPECTED_SCHEMA: an object the database returned
 * is judged by its own `present` flag, and an object the database has no row
 * for is missing by definition — a registration row only exists once the
 * migration that inserts it has run. Rows newer than this build still count,
 * so a database ahead of the code is reported rather than silently dropped.
 */
export function summarizeSchemaHealth(rows: SchemaCheck[]): DatabaseHealth {
  const reported = new Map<string, SchemaCheck>();
  for (const row of rows) {
    if (typeof row?.object_name !== "string" || typeof row?.migration !== "string") continue;
    reported.set(row.object_name, row);
  }

  const missingByMigration = new Map<string, string[]>();
  let checkedObjects = 0;
  const note = (name: string, migration: string, present: boolean): void => {
    checkedObjects += 1;
    if (present) return;
    const objects = missingByMigration.get(migration) ?? [];
    objects.push(name);
    missingByMigration.set(migration, objects);
  };

  for (const expected of EXPECTED_SCHEMA) {
    const row = reported.get(expected.object_name);
    if (!row) {
      // Registered nowhere: the migration that inserts this row has not run,
      // so this build's copy of the list is the only witness to it.
      note(expected.object_name, expected.migration, false);
      continue;
    }
    note(expected.object_name, row.migration, Boolean(row.present));
    reported.delete(expected.object_name);
  }
  // Anything the database knows that this build does not: still a fact about
  // the schema, and worth reporting rather than dropping on the floor.
  for (const row of reported.values()) {
    note(row.object_name, row.migration, Boolean(row.present));
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

/**
 * The report when the audit could not run, with the reason kept readable.
 */
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
