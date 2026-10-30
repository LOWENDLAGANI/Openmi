#!/usr/bin/env node
//
// ── Can the migration folder be applied twice? ──────────────────────────────
//
// `supabase db push` stops at the first file that errors, and every migration
// after it is never applied. That is how a deployment ends up with correct
// migration files and a missing table: `agent_runs` was fine, but an earlier
// file had already been applied and could not be read again, so the run table
// was never reached and every repository turn failed to start.
//
// The check is the obvious one: apply the whole set to an empty Postgres,
// twice, in filename order, each file in its own transaction exactly as the CLI
// does. The second pass is the one that matters — on a project whose history
// has drifted, that is the pass a repair actually performs.
//
// PGlite is Postgres compiled to WebAssembly. It is used instead of a service
// container so the same command works on a laptop and in CI with no Docker, and
// so the engine is the real parser and executor rather than a mock. The
// Supabase-provided surface (auth, storage, roles) comes from
// `scripts/supabase-stub.sql`; this file is otherwise the repository's own SQL.
//
// It exits non-zero on the first failure and names the file and the pass, which
// is the one thing a red build has to say.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const stubPath = path.join(here, "supabase-stub.sql");

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const files = (await readdir(migrationsDir))
  .filter((name) => name.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  fail(`No migrations found in ${migrationsDir}.`);
}

// Two passes are the whole point; anything else is a different test.
const PASSES = 2;

const db = await PGlite.create();

try {
  await db.exec(await readFile(stubPath, "utf8"));

  for (let pass = 1; pass <= PASSES; pass += 1) {
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      try {
        // One transaction per file, matching `supabase db push`: a file either
        // lands whole or not at all, so the next pass starts from a defined
        // state instead of halfway through a failed migration.
        await db.transaction(async (tx) => {
          await tx.exec(sql);
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(
          [
            `${file} failed on pass ${pass} of ${PASSES}.`,
            "",
            "A project that has already applied this file cannot apply it again,",
            "so `supabase db push` will stop here and never reach the migrations",
            "after it.",
            "",
            detail,
          ].join("\n")
        );
      }
    }
    console.log(`  pass ${pass}/${PASSES}: ${files.length} migrations applied`);
  }

  // ── The schema the app actually calls ─────────────────────────────────────
  // Applying without error is necessary but not sufficient: a migration can
  // succeed and still leave an object missing (a column renamed by a later file,
  // a table whose registration was skipped). These assertions are the ones tied
  // to real release failures, not a general inventory.

  const health = await db.query(
    "select object_name, kind, migration from public.openmi_schema_health() where not present"
  );
  if (health.rows.length > 0) {
    const missing = health.rows
      .map((row) => `  ${row.kind} ${row.object_name} (${row.migration})`)
      .join("\n");
    fail(`openmi_schema_health() reports objects the migrations never created:\n${missing}`);
  }

  // The health function is table-driven. If `schema_expected` were empty, the
  // query above would pass without looking at a single object, so its size is
  // checked too: a check that cannot fail is not a check.
  const expected = await db.query("select count(*)::int as total from public.schema_expected");
  if (!expected.rows[0]?.total) {
    fail("public.schema_expected is empty, so openmi_schema_health() proved nothing.");
  }

  // The table behind the release failure has to be one of the registered
  // objects, or its absence would not be part of what this check verifies.
  const registered = await db.query(
    "select count(*)::int as total from public.schema_expected where object_name = 'agent_runs'"
  );
  if (registered.rows[0]?.total !== 1) {
    fail("public.agent_runs is not registered in schema_expected, so the health check cannot notice it missing.");
  }

  // `agent_runs` is written only through the service key, by design. A grant to
  // `authenticated` here would be a policy hole; no table at all is the bug this
  // check exists for. Both are checked because "the migration ran" and "the
  // migration ran and granted the right thing" are different claims.
  const runs = await db.query(`
    select
      has_table_privilege('authenticated', 'public.agent_runs', 'SELECT') as can_select,
      has_table_privilege('authenticated', 'public.agent_runs', 'INSERT') as can_insert
  `);
  const runGrants = runs.rows[0];
  if (!runGrants?.can_select || runGrants.can_insert) {
    fail(
      "public.agent_runs does not have the grants the routes rely on: " +
        "authenticated must be able to SELECT its own rows and must not be able to INSERT."
    );
  }

  // The run tick writes with the service key. Supabase's default privileges
  // usually supply this, but a project whose defaults were reset — or a table
  // that already existed when `create table if not exists` ran — leaves the
  // role without INSERT while the table is present and the health audit is
  // happy. Every run then fails at 42501 with a sentence about a grant, so the
  // folder has to grant it explicitly and this check has to prove it.
  const writer = await db.query(`
    select
      has_table_privilege('service_role', 'public.agent_runs', 'SELECT') as runs_select,
      has_table_privilege('service_role', 'public.agent_runs', 'INSERT') as runs_insert,
      has_table_privilege('service_role', 'public.agent_runs', 'UPDATE') as runs_update,
      has_table_privilege('service_role', 'public.agent_runs', 'DELETE') as runs_delete,
      has_table_privilege('service_role', 'public.changesets', 'INSERT') as changesets_insert,
      has_table_privilege('service_role', 'public.changesets', 'UPDATE') as changesets_update
  `);
  const writerGrants = writer.rows[0] ?? {};
  const missingWriter = Object.entries(writerGrants)
    .filter(([, granted]) => !granted)
    .map(([privilege]) => privilege);
  if (missingWriter.length > 0) {
    fail(
      "service_role cannot do what the run tick needs: " +
        `${missingWriter.join(", ")}. Grant it explicitly in the migrations rather ` +
        "than relying on a hosted project's default privileges."
    );
  }

  // The receipt states were a two-step rename. If only the constraint half
  // applied, the console reads a column that is not there.
  const receipts = await db.query(`
    select count(*)::int as present
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'payment_receipts'
      and column_name in ('decided_at', 'decided_by')
  `);
  if (receipts.rows[0]?.present !== 2) {
    fail("public.payment_receipts is missing decided_at/decided_by after the rename migration.");
  }

  console.log(`\n✓ ${files.length} migrations applied ${PASSES}× cleanly; the schema they promise is present.\n`);
} finally {
  await db.close();
}
