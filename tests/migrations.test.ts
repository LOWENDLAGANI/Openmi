// ── Openmi — the migrations must be re-runnable ─────────────────────────────
//
// A migration that is applied once by `supabase db push` is a file nobody looks
// at again — until the day the project's history and this folder disagree and
// the owner pastes the files into the SQL editor to repair it. Then a single
// unguarded statement aborts the batch, and every migration after it — the
// newest table, the one the running build needs — is never applied. That is the
// exact shape of "Openmi could not answer: this run could not be recorded".
//
// So the property worth pinning is not "the SQL is valid" (a database proves
// that) but "running this file twice is harmless". These checks are the parts of
// that property a reader can enforce without a server:
//
//   * every `create policy` is preceded by its `drop policy if exists`;
//   * every `add constraint` is preceded by a drop or by a catalog guard;
//   * every plain `create function` is preceded by a drop of the same signature
//     (`create or replace` needs none);
//   * the versions are unique and strictly increasing, so the order the CLI
//     applies them is the order they were written in;
//   * every migration named by `schema_expected` exists as a file, because the
//     health audit resolves that name to a sentence an operator acts on.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort();

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

function read(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

console.log("migrations");

check("every filename carries a unique, increasing 14-digit version", () => {
  assert.ok(files.length > 0, "no migrations found");
  const versions = files.map((name) => name.slice(0, 14));
  for (const [index, version] of versions.entries()) {
    assert.match(version, /^\d{14}$/, `${files[index]} does not start with a version`);
    if (index === 0) continue;
    assert.ok(
      version > versions[index - 1]!,
      `${files[index]} sorts at or before ${files[index - 1]}, so the CLI's order is not the written order`
    );
  }
});

check("every policy is dropped before it is created", () => {
  for (const file of files) {
    const sql = read(file);
    for (const match of sql.matchAll(/create\s+policy\s+([a-z0-9_]+)\s+on/gi)) {
      const name = match[1]!;
      const before = sql.slice(0, match.index);
      assert.match(
        before,
        new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${escape(name)}\\s+on`, "i"),
        `${file}: policy ${name} is created without being dropped first`
      );
    }
  }
});

check("every added constraint is dropped or guarded by the catalog first", () => {
  for (const file of files) {
    const sql = read(file);
    for (const match of sql.matchAll(/add\s+constraint\s+([a-z0-9_]+)/gi)) {
      const name = match[1]!;
      const before = sql.slice(0, match.index);
      const dropped = new RegExp(`drop\\s+constraint\\s+if\\s+exists\\s+${escape(name)}`, "i").test(before);
      // The other accepted form: `if not exists (select 1 from pg_constraint …) then
      // alter table … add constraint …`. That is how the two conditional checks
      // are written, and it is a guard rather than an omission.
      const window = sql.slice(Math.max(0, match.index - 900), match.index);
      const guarded = /if\s+not\s+exists\s*\(\s*select\s+1\s+from\s+pg_constraint/i.test(window);
      assert.ok(dropped || guarded, `${file}: constraint ${name} is added without a guard`);
    }
  }
});

check("a plain `create function` is preceded by a drop covering its arguments", () => {
  /** `p_model text default 'auto'` → `text`, so a name or a default cannot hide a match. */
  const typesOf = (args: string): string =>
    args
      .split(",")
      .map((arg) => arg.replace(/default[\s\S]*$/i, "").trim())
      .filter(Boolean)
      .map((arg) => arg.split(/\s+/).pop()!.toLowerCase())
      .join(",");

  for (const file of files) {
    const sql = read(file);
    for (const match of sql.matchAll(/(?<!or replace )create\s+function\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi)) {
      const name = match[1]!;
      const wanted = typesOf(match[2]!);
      const before = sql.slice(0, match.index);
      const drops = [
        ...before.matchAll(
          new RegExp(`drop\\s+function\\s+if\\s+exists\\s+public\\.${escape(name)}\\s*\\(([^)]*)\\)`, "gi")
        ),
      ];
      const covered = drops.some((drop) => typesOf(drop[1] ?? "") === wanted);
      assert.ok(
        covered,
        `${file}: create function ${name}(${wanted}) has no matching drop, so a re-run stops at "already exists"`
      );
    }
  }
});

check("the scoped hour function drops both of its signatures before it is created", () => {
  const sql = read("20261028000300_session_scope.sql");
  assert.match(sql, /drop function if exists public\.start_hour_session\(\);/);
  assert.match(sql, /drop function if exists public\.start_hour_session\(text, text\);/);
});

check("the DeepSeek migration drops the named constraint it adds", () => {
  const sql = read("20261027000000_provider_keys_deepseek.sql");
  assert.match(sql, /drop constraint if exists provider_keys_provider_allowed;[\s\S]*add constraint provider_keys_provider_allowed/);
});

check("the audit's action list is a superset, and is re-addable", () => {
  const sql = read("20261028000000_pricing_sessions.sql");
  assert.match(sql, /drop constraint if exists admin_audit_action_allowed;[\s\S]*add constraint admin_audit_action_allowed/);
  for (const action of ["grantPlan", "deductDew", "saveReceipt", "rejectReceipt", "deleteReceipt"]) {
    assert.ok(sql.includes(`'${action}'`), `a re-run would narrow the ledger: ${action} is missing`);
  }
});

check("the receipt rename checks the old column before moving it", () => {
  const sql = read("20261029000500_receipt_states.sql");
  assert.match(sql, /information_schema\.columns[\s\S]*column_name = 'saved_at'[\s\S]*rename column saved_at to decided_at/);
  assert.match(sql, /column_name = 'saved_by'[\s\S]*rename column saved_by to decided_by/);
});

check("the receipts migration never names a renamed column at the top level", () => {
  const sql = read("20261029000200_receipts_and_deduct.sql");
  // The guarded index is the one place the old column may be named outside the
  // table definition. A bare `create index … (status, saved_at)` here would
  // abort a re-run after 20261029000500 has renamed the column.
  const marker = "create index if not exists payment_receipts_saved_idx";
  const occurrences = sql.split(marker).length - 1;
  assert.equal(occurrences, 1, "the saved_at index must be written exactly once");
  const at = sql.indexOf(marker);
  assert.match(
    sql.slice(Math.max(0, at - 400), at),
    /then\s*$/,
    "the saved_at index must stay inside the column check"
  );
  assert.match(sql, /execute 'create policy payment_receipts_insert_own/);
});

check("agent_runs is readable by its owner and writable by nothing else", () => {
  const sql = read("20261029000000_agent_runs.sql");
  assert.match(sql, /create table if not exists public\.agent_runs/);
  assert.match(sql, /grant select on public\.agent_runs to authenticated/);
  assert.doesNotMatch(sql, /grant[^;]*insert[^;]*agent_runs/i);
  assert.doesNotMatch(sql, /grant[^;]*update[^;]*agent_runs/i);
  assert.match(sql, /primary key \(owner, id\)/);
});

check("every migration named in schema_expected exists as a file", () => {
  const versions = new Set(files.map((name) => name.slice(0, 14)));
  for (const file of files) {
    const sql = read(file);
    for (const match of sql.matchAll(/'(\d{14})_[a-z0-9_]+'/g)) {
      const version = match[1]!;
      assert.ok(
        versions.has(version),
        `${file} names migration ${version}, which this folder does not contain`
      );
    }
  }
});

check("the seed is an upsert, so it can be run after a repair", () => {
  const seed = readFileSync(join(process.cwd(), "supabase", "seed.sql"), "utf8");
  assert.match(seed, /on conflict \(id\) do update set email = excluded\.email/);
  assert.match(seed, /on conflict \(id\) do nothing/);
});

check("the run table is registered with the health audit", () => {
  const sql = read("20261029000100_agent_runs_health.sql");
  assert.match(sql, /insert into public\.schema_expected[\s\S]*agent_runs/);
  assert.match(sql, /20261029000000_agent_runs/);
});

console.log(`\n${passed + failed} checks`);
if (failed > 0) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("migrations: all checks passed");
