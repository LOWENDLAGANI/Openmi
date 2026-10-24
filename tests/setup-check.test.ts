// ── Openmi — tests for the setup checklist ───────────────────────────────────
//
// The banner on the About page promises two things, and both are worth pinning
// because the whole feature is a to-do list:
//
//   1. It names what is actually missing, and nothing else. A key that has
//      been set disappears from the list — if that ever stops holding, an owner
//      is left fixing something they already fixed.
//   2. It never leaks a value. The report is public, and the difference
//      between "OPENROUTER_API_KEY is set" and "it starts with sk-or-v1-…" is
//      the whole security boundary of this endpoint.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupReport, type SetupItem } from "../lib/setupChecks";
import {
  SCHEMA_HEALTH_MIGRATION,
  isMissingFunction,
  missingHealthFunction,
  summarizeSchemaHealth,
  type SchemaCheck,
} from "../lib/schemaHealth";

let failures = 0;
let passes = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Every variable the report could look at. */
const TOUCHED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "TAVILY_API_KEY",
  "OPENMI_ADMIN_EMAIL",
  "GITHUB_TOKEN_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AGENT_TURN_SECRET",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "NEXT_PUBLIC_SITE_URL",
];

const saved = new Map<string, string | undefined>();

/** Runs `body` with a completely empty environment, then restores it. */
function withEmptyEnv(body: () => void): void {
  for (const key of TOUCHED) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const keysOf = (items: SetupItem[]): string[] => items.flatMap((item) => item.keys);

console.log("setup checklist");

test("an empty deployment reports the keys that stop it working, and names each one", () => {
  withEmptyEnv(() => {
    const report = setupReport();
    const named = keysOf(report.missing);
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "OPENROUTER_API_KEY", "GEMINI_API_KEY"]) {
      assert.ok(named.includes(key), `expected ${key} in the report`);
    }
    // Every reported item explains itself: a name alone tells an owner nothing.
    for (const item of report.missing) {
      assert.ok(item.label.trim().length > 0, "every item has a label");
      assert.ok(item.missing.trim().length > 20, `item ${item.label} says what stops working`);
      assert.ok(item.where.trim().length > 20, `item ${item.label} says where the value comes from`);
    }
    assert.equal(report.checked, report.configured + report.missing.length);
  });
});

test("a key that has been set disappears from the list", () => {
  withEmptyEnv(() => {
    const before = setupReport();
    assert.ok(keysOf(before.missing).includes("TAVILY_API_KEY"));

    process.env.TAVILY_API_KEY = "tvly-demo";
    const after = setupReport();
    assert.equal(after.checked, before.checked, "the same items are still considered");
    assert.ok(!keysOf(after.missing).includes("TAVILY_API_KEY"), "a set key is never listed again");
    assert.equal(after.configured, before.configured + 1);
  });
});

test("required problems are listed before optional ones", () => {
  withEmptyEnv(() => {
    const severities = setupReport().missing.map((item) => item.severity);
    const firstOptional = severities.indexOf("optional");
    const lastRequired = severities.lastIndexOf("required");
    assert.ok(lastRequired >= 0 && firstOptional >= 0, "the empty report has both kinds");
    assert.ok(lastRequired < firstOptional, "an owner fixes what stops the product working first");
  });
});

test("a secret is never put in the report, only the fact that one exists", () => {
  withEmptyEnv(() => {
    const secret = "sk-or-v1-abcdef0123456789abcdef0123456789";
    process.env.OPENROUTER_API_KEY = secret;
    const serialised = JSON.stringify(setupReport());
    assert.ok(!serialised.includes(secret), "no value may reach the page");
    assert.ok(!serialised.includes("abcdef"), "not even a fragment of one");
    assert.ok(!keysOf(setupReport().missing).includes("OPENROUTER_API_KEY"));
  });
});

test("a GitHub OAuth App with only half its pair set is named as a problem", () => {
  withEmptyEnv(() => {
    // Neither half set: the deployment chose the pasted-token door, which
    // needs no OAuth App and deserves no warning.
    assert.ok(!keysOf(setupReport().missing).includes("GITHUB_CLIENT_ID"));

    process.env.GITHUB_CLIENT_ID = "Iv1.example";
    const half = setupReport();
    assert.ok(
      keysOf(half.missing).includes("GITHUB_CLIENT_ID"),
      "one half of the pair is a mistake worth naming"
    );

    process.env.GITHUB_CLIENT_SECRET = "example-secret";
    assert.ok(!keysOf(setupReport().missing).includes("GITHUB_CLIENT_ID"));
  });
});

test("the agent's turn secret is satisfied by the GitHub token key", () => {
  withEmptyEnv(() => {
    assert.ok(keysOf(setupReport().missing).includes("AGENT_TURN_SECRET"));
    process.env.GITHUB_TOKEN_KEY = "0".repeat(64);
    assert.ok(!keysOf(setupReport().missing).includes("AGENT_TURN_SECRET"));
  });
});

test("the endpoint returns the report and nothing else", () => {
  const source = readFileSync("app/api/setup/route.ts", "utf8");
  assert.match(source, /setupReport\(\)/);
  assert.match(source, /databaseHealth\(\)/);
  // Spreading the environment would be the leak this endpoint exists to avoid.
  assert.doesNotMatch(source, /\.\.\.process\.env/);
  assert.doesNotMatch(source, /process\.env\[/);
});

// ── The schema audit ─────────────────────────────────────────────────────────
//
// The environment list cannot see a missing migration. These pin the half that
// can: missing objects grouped by the migration that creates them, so the
// banner names one command instead of a wall of table names.

test("missing schema objects are grouped under the migration that adds them", () => {
  const rows: SchemaCheck[] = [
    { object_name: "profiles", kind: "table", present: true, migration: "20261023000100_identity" },
    { object_name: "profiles.timezone", kind: "column", present: false, migration: "20261024000300_dew_timezone" },
    { object_name: "set_profile_timezone(text)", kind: "function", present: false, migration: "20261024000300_dew_timezone" },
    { object_name: "dew_wallets.daily_day", kind: "column", present: false, migration: "20261024000200_daily_dew" },
  ];
  const report = summarizeSchemaHealth(rows);
  assert.equal(report.checked, true);
  assert.equal(report.reachable, true);
  assert.equal(report.checkedObjects, 4);
  assert.deepEqual(report.missing, [
    { migration: "20261024000200_daily_dew", objects: ["dew_wallets.daily_day"] },
    {
      migration: "20261024000300_dew_timezone",
      objects: ["profiles.timezone", "set_profile_timezone(text)"],
    },
  ]);
});

test("a complete schema reports no gaps", () => {
  const report = summarizeSchemaHealth([
    { object_name: "profiles", kind: "table", present: true, migration: "a" },
    { object_name: "is_admin()", kind: "function", present: true, migration: "b" },
  ]);
  assert.deepEqual(report.missing, []);
  assert.equal(report.checkedObjects, 2);
});

test("a missing health function names its own migration rather than an outage", () => {
  assert.equal(isMissingFunction({ code: "PGRST202" }), true);
  assert.equal(isMissingFunction({ code: "PGRST204" }), false);
  assert.equal(isMissingFunction(null), false);
  const report = missingHealthFunction();
  assert.equal(report.reachable, true);
  assert.deepEqual(report.missing, [
    { migration: SCHEMA_HEALTH_MIGRATION, objects: ["openmi_schema_health"] },
  ]);
});

test("the audit is public, presence-only, and lists the load-bearing objects", () => {
  const sql = readFileSync("supabase/migrations/20261024000400_schema_health.sql", "utf8");
  assert.match(sql, /create or replace function public\.openmi_schema_health\(\)/);
  assert.match(sql, /grant execute on function public\.openmi_schema_health\(\) to anon, authenticated/);
  assert.match(sql, /revoke all on function public\.openmi_schema_health\(\) from public/);
  for (const object of ["profiles.timezone", "dew_wallets.daily_day", "deduct_dew(numeric)", "is_admin()"]) {
    assert.ok(sql.includes(object), `the audit must check ${object}`);
  }
  // It reports names only; a select of real data here would be a leak.
  assert.doesNotMatch(sql, /select[^;]*from public\.(chats|chat_messages|dew_credits|profiles)\b/i);
});

console.log(`\n${passes + failures} checks`);
if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("setup-check: all checks passed");
