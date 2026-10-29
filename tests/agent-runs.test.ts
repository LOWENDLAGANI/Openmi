// ── Openmi — the run claim, the tick token and the watchdog ──────────────────
//
// Background execution has exactly one safety property: two ticks on one run must
// not spend two model calls. Everything here is that property, or a piece that
// would quietly undermine it.
//
//   bun run test
//
// No network and no database: the one write is exercised against a stand-in for
// the single table it touches, which applies the same conditional filter the
// database would. If `claimRun` ever loses an `.eq`, these fail.

import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  RUN_MAX_ATTEMPTS,
  claimRun,
  normalizeRun,
  openRunState,
  sealRunState,
  sweepAction,
  toView,
  type AgentRunState,
} from "../lib/agentRuns";
import { TICK_TTL_MS, signTick, tickVerdict, verifyTick } from "../lib/agentRunToken";

// A sealed state needs a key, and `tokenKey` reads it per call. Pinned here so
// the round-trip and the foreign-key refusal are both testable without a
// deployment.
const KEY_ONE = "1".repeat(64);
const KEY_TWO = "2".repeat(64);
process.env.GITHUB_TOKEN_KEY = KEY_ONE;

type Row = Record<string, unknown>;

let passed = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${label}`);
    });
}

/**
 * The one table the claim writes, with the filter that matters.
 *
 * `select()` applies every `.eq()` the caller chained before touching a row, so
 * a claim that presented a stale attempt, a foreign owner or the wrong id simply
 * matches nothing — which is the database's behaviour, not a simplification
 * that would let a broken claim pass.
 */
interface UpdateBuilder {
  eq(column: string, value: unknown): UpdateBuilder;
  select(): Promise<{ data: Array<{ id: unknown }>; error: null }>;
}

function fakeAgentRuns(rows: Row[]): SupabaseClient {
  const update = (values: Row): UpdateBuilder => {
    const filters: Array<[string, unknown]> = [];
    const builder: UpdateBuilder = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return builder;
      },
      async select() {
        const matched = rows.filter((row) => filters.every(([column, value]) => row[column] === value));
        for (const row of matched) Object.assign(row, values);
        return { data: matched.map((row) => ({ id: row.id })), error: null };
      },
    };
    return builder;
  };
  return {
    from(table: string) {
      assert.equal(table, "agent_runs");
      return { update };
    },
  } as unknown as SupabaseClient;
}

const STATE: AgentRunState = {
  v: 1,
  uid: "user-a",
  project: { id: "p1", repoFullName: "owner/repo", defaultBranch: "main", baseSha: "a".repeat(40) },
  githubToken: "ghs_a_token_that_must_not_leak",
  accountKeys: { openrouter: "sk-or-secret" },
  history: [{ role: "user", content: "fix the build" }],
  transcript: [],
  context: "",
  content: "",
  steps: [],
  attempt: 0,
};

async function main(): Promise<void> {
  // ── The claim ─────────────────────────────────────────────────────────────

  await check("the first tick at an attempt wins and advances the row", async () => {
    const rows: Row[] = [{ id: "run-1", owner: "user-a", status: "running", attempts: 0 }];
    const client = fakeAgentRuns(rows);
    assert.equal(await claimRun("run-1", "user-a", 0, { client }), true);
    assert.equal(rows[0]!.attempts, 1);
  });

  await check("a replay at the same attempt wins nothing and spends nothing", async () => {
    const rows: Row[] = [{ id: "run-1", owner: "user-a", status: "running", attempts: 0 }];
    const client = fakeAgentRuns(rows);
    assert.equal(await claimRun("run-1", "user-a", 0, { client }), true);
    assert.equal(await claimRun("run-1", "user-a", 0, { client }), false);
    assert.equal(rows[0]!.attempts, 1, "a refused claim must not move the attempt");
  });

  await check("the next link claims the attempt the previous one wrote", async () => {
    const rows: Row[] = [{ id: "run-1", owner: "user-a", status: "running", attempts: 0 }];
    const client = fakeAgentRuns(rows);
    assert.equal(await claimRun("run-1", "user-a", 0, { client }), true);
    assert.equal(await claimRun("run-1", "user-a", 1, { client }), true);
    assert.equal(rows[0]!.attempts, 2);
  });

  await check("another run's id claims nothing", async () => {
    const rows: Row[] = [{ id: "run-1", owner: "user-a", status: "running", attempts: 0 }];
    const client = fakeAgentRuns(rows);
    assert.equal(await claimRun("run-2", "user-a", 0, { client }), false);
    assert.equal(rows[0]!.attempts, 0);
  });

  await check("another account's id claims nothing", async () => {
    const rows: Row[] = [{ id: "run-1", owner: "user-a", status: "running", attempts: 0 }];
    const client = fakeAgentRuns(rows);
    assert.equal(await claimRun("run-1", "user-b", 0, { client }), false);
    assert.equal(rows[0]!.attempts, 0);
  });

  await check("a finished run cannot be resumed by a late link", async () => {
    const rows: Row[] = [{ id: "run-1", owner: "user-a", status: "done", attempts: 7 }];
    const client = fakeAgentRuns(rows);
    assert.equal(await claimRun("run-1", "user-a", 7, { client }), false);
  });

  await check("a cancelled run cannot be claimed either", async () => {
    const rows: Row[] = [{ id: "run-1", owner: "user-a", status: "cancelled", attempts: 2 }];
    const client = fakeAgentRuns(rows);
    assert.equal(await claimRun("run-1", "user-a", 2, { client }), false);
  });

  await check("no client means no claim, rather than a crash", async () => {
    assert.equal(await claimRun("run-1", "user-a", 0, { client: null }), false);
  });

  // ── The verdict ───────────────────────────────────────────────────────────

  const claim = { run: "run-1", uid: "user-a", attempt: 3, exp: Date.now() + 60_000 };

  await check("a matching running row is advanced", () => {
    assert.equal(tickVerdict({ owner: "user-a", status: "running", attempts: 3 }, claim), "advance");
  });

  await check("a token for a missing run is missing, not advanced", () => {
    assert.equal(tickVerdict(null, claim), "missing");
  });

  await check("a token for somebody else's run never reaches their row", () => {
    assert.equal(tickVerdict({ owner: "user-b", status: "running", attempts: 3 }, claim), "missing");
  });

  await check("a finished or cancelled run ends the chain", () => {
    assert.equal(tickVerdict({ owner: "user-a", status: "done", attempts: 3 }, claim), "finished");
    assert.equal(tickVerdict({ owner: "user-a", status: "cancelled", attempts: 3 }, claim), "finished");
    assert.equal(tickVerdict({ owner: "user-a", status: "failed", attempts: 3 }, claim), "finished");
  });

  await check("a stale attempt is a claimed duplicate", () => {
    assert.equal(tickVerdict({ owner: "user-a", status: "running", attempts: 4 }, claim), "claimed");
    assert.equal(tickVerdict({ owner: "user-a", status: "running", attempts: 2 }, claim), "claimed");
  });

  // ── The token ─────────────────────────────────────────────────────────────

  await check("a signed tick round-trips with the attempt it was minted for", () => {
    const token = signTick({ run: "run-1", uid: "user-a", attempt: 5 });
    const opened = verifyTick(token);
    assert.ok(opened);
    assert.equal(opened!.run, "run-1");
    assert.equal(opened!.uid, "user-a");
    assert.equal(opened!.attempt, 5);
  });

  await check("an expired tick is refused", () => {
    const now = Date.now();
    const token = signTick({ run: "run-1", uid: "user-a", attempt: 0 }, now);
    assert.ok(verifyTick(token, now + 1_000));
    assert.equal(verifyTick(token, now + TICK_TTL_MS + 1), null);
  });

  await check("a truncated or tampered tick is refused", () => {
    const token = signTick({ run: "run-1", uid: "user-a", attempt: 0 });
    assert.equal(verifyTick(token.slice(0, -3)), null);
    const body = token.slice(0, token.lastIndexOf("."));
    assert.equal(verifyTick(`${body}.${"A".repeat(43)}`), null);
    assert.equal(verifyTick(""), null);
  });

  await check("a token that claims a negative attempt is refused", () => {
    // Signed by this deployment, but not a claim any tick may present.
    const forged = signTick({ run: "run-1", uid: "user-a", attempt: -1 });
    assert.equal(verifyTick(forged), null);
  });

  // ── The sealed state ──────────────────────────────────────────────────────

  const sealed = sealRunState(STATE);

  await check("sealing produces ciphertext, not the credentials inside it", () => {
    assert.ok(sealed);
    assert.ok(sealed!.startsWith("v1."), "the prefix is what identifies the format");
    assert.ok(!sealed!.includes("ghs_a_token_that_must_not_leak"));
    assert.ok(!sealed!.includes("sk-or-secret"));
  });

  await check("the same key opens exactly what was sealed", () => {
    assert.deepEqual(openRunState(sealed!), STATE);
  });

  await check("a different key opens nothing", () => {
    process.env.GITHUB_TOKEN_KEY = KEY_TWO;
    assert.equal(openRunState(sealed!), null);
    process.env.GITHUB_TOKEN_KEY = KEY_ONE;
  });

  await check("a value this module did not produce is not state", () => {
    assert.equal(openRunState(""), null);
    assert.equal(openRunState("not-a-seal"), null);
    assert.equal(openRunState("v1.aaaa.bbbb.cccc"), null);
  });

  // ── What the chat is allowed to see ───────────────────────────────────────

  const record = normalizeRun({
    id: "run-1",
    owner: "user-a",
    project_id: "p1",
    repo_full_name: "owner/repo",
    status: "running",
    content: "partial answer",
    steps: [{ tool: "read_file", label: "read a.ts", ok: true }],
    proposals: [],
    changeset_id: null,
    review: null,
    truncated: false,
    prompt_tokens: 10,
    completion_tokens: 5,
    error: null,
    state: sealed,
    attempts: 2,
    created_at: new Date().toISOString(),
  });

  await check("the view carries no state, no owner and no credential", () => {
    assert.ok(record);
    const view = toView(record!);
    assert.ok(!("state" in view));
    assert.ok(!("owner" in view));
    assert.ok(!JSON.stringify(view).includes("ghs_a_token_that_must_not_leak"));
    assert.ok(!JSON.stringify(view).includes("sk-or-secret"));
  });

  await check("the view still carries what the chat renders", () => {
    const view = toView(record!);
    assert.equal(view.id, "run-1");
    assert.equal(view.status, "running");
    assert.equal(view.content, "partial answer");
    assert.equal(view.steps.length, 1);
    assert.deepEqual(view.usage, { prompt: 10, completion: 5 });
  });

  // ── The watchdog ──────────────────────────────────────────────────────────

  await check("a stale run below the budget is revived at the attempt it holds", () => {
    assert.deepEqual(sweepAction({ attempts: 0 }), { action: "revive", attempt: 0 });
    assert.deepEqual(sweepAction({ attempts: RUN_MAX_ATTEMPTS - 1 }), {
      action: "revive",
      attempt: RUN_MAX_ATTEMPTS - 1,
    });
  });

  await check("a stale run at or past the budget is abandoned, not re-run", () => {
    assert.deepEqual(sweepAction({ attempts: RUN_MAX_ATTEMPTS }), { action: "abandon" });
    assert.deepEqual(sweepAction({ attempts: RUN_MAX_ATTEMPTS + 5 }), { action: "abandon" });
  });

  console.log(`\nagent-runs: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
