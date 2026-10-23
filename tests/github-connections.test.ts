// ── Openmi — the GitHub connection collection ────────────────────────────────
//
// The storage module reads its project address and its sealing key from the
// environment *when it is imported*, so this file sets both before the first
// dynamic import. That is why it lives in its own suite: the rest of the tests
// deliberately run with no deployment configured.
//
// The only thing stubbed is Postgres. The fake below speaks the slice of
// PostgREST this module actually uses — filter by `eq`, order, upsert on
// conflict, update, delete, and the single-object `Accept` header — so the real
// query builder and the real requests are exercised, and sealing, unsealing, the
// default pointer and replacement-on-reconnect are the real code.
//
//   bun run test

import assert from "node:assert/strict";

const OAUTH_KEY = "9f".repeat(32);
process.env.GITHUB_TOKEN_KEY = OAUTH_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://openmi.test";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

type Row = Record<string, unknown>;

/**
 * A very small PostgREST stand-in.
 *
 * Every row lives in a per-table array. The supported query surface is exactly
 * what lib/github/connections.ts issues: `eq` filters, one `order`, `on_conflict`
 * for upserts, and the `application/vnd.pgrst.object+json` accept header that
 * `.maybeSingle()` sends. Anything else is answered as an empty result rather
 * than guessed at.
 */
function installPostgrestStub(): {
  tables: Map<string, Row[]>;
  restore: () => void;
} {
  const tables = new Map<string, Row[]>();
  const rowsFor = (table: string) => {
    const existing = tables.get(table);
    if (existing) return existing;
    const created: Row[] = [];
    tables.set(table, created);
    return created;
  };

  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    const wantsSingle = (headers.get("accept") ?? "").includes("pgrst.object");
    const rows = rowsFor(table);

    const filters: Array<[string, string]> = [];
    const onConflict = url.searchParams.get("on_conflict");
    let order: { column: string; ascending: boolean } | null = null;
    for (const [key, value] of url.searchParams.entries()) {
      if (key === "select") continue;
      if (key === "on_conflict") continue;
      if (key === "order") {
        const [column, direction] = value.split(".");
        order = { column: column!, ascending: direction !== "desc" };
        continue;
      }
      if (value.startsWith("eq.")) filters.push([key, value.slice(3)]);
    }

    const matches = (row: Row) => filters.every(([column, expected]) => String(row[column]) === expected);

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    const single = (row: Row | undefined) => {
      if (!row) {
        return json(
          { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
          406
        );
      }
      return json(row);
    };

    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Row | Row[];
      const incoming = Array.isArray(body) ? body : [body];
      const keys = (onConflict ?? "").split(",").filter(Boolean);
      for (const entry of incoming) {
        const existing = keys.length
          ? rows.find((row) => keys.every((key) => String(row[key]) === String(entry[key])))
          : undefined;
        if (existing) Object.assign(existing, entry);
        else rows.push({ ...entry });
      }
      return new Response(null, { status: 201 });
    }

    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Row;
      for (const row of rows.filter(matches)) Object.assign(row, body);
      return new Response(null, { status: 204 });
    }

    if (method === "DELETE") {
      const kept = rows.filter((row) => !matches(row));
      rows.splice(0, rows.length, ...kept);
      return new Response(null, { status: 204 });
    }

    const found = rows.filter(matches);
    if (order) {
      const { column, ascending } = order;
      found.sort((a, b) => {
        const left = String(a[column] ?? "");
        const right = String(b[column] ?? "");
        const compared = left.localeCompare(right);
        return ascending ? compared : -compared;
      });
    }
    if (wantsSingle) return single(found[0]);
    return json(found);
  }) as typeof fetch;

  return {
    tables,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

(async () => {
  const {
    connectionIdFor,
    defaultGithubConnection,
    deleteGithubConnection,
    listGithubConnections,
    readGithubConnection,
    saveGithubConnection,
    setDefaultConnection,
  } = await import("../lib/github/connections");

  const stub = installPostgrestStub();

  const auth = "Bearer test-token";
  const uid = "uid-1";
  const octocatToken = `ghp_${"a".repeat(36)}`;
  const hubotToken = `ghp_${"b".repeat(36)}`;
  const rotatedToken = `ghp_${"c".repeat(36)}`;

  let failures = 0;
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  };

  try {
    const first = await saveGithubConnection(auth, uid, {
      token: octocatToken,
      login: "octocat",
      scopes: "repo",
      kind: "pat",
      label: "personal",
      canReadRepos: true,
    });

    await check("the first connection is saved under its login-derived id", () => {
      assert.ok(first);
      assert.equal(first!.id, connectionIdFor("octocat"));
    });

    await check("the first connection becomes the default", async () => {
      const chosen = await defaultGithubConnection(auth, uid);
      assert.equal(chosen?.token, octocatToken);
    });

    await saveGithubConnection(auth, uid, {
      token: hubotToken,
      login: "hubot",
      scopes: "public_repo",
      kind: "oauth",
      label: "work",
      canReadRepos: true,
    });

    const list = await listGithubConnections(auth, uid);

    await check("two GitHub accounts are two connections", () => {
      assert.equal(list.length, 2);
    });

    await check("a summary never carries the token", () => {
      for (const entry of list) assert.equal("token" in entry, false);
      const stored = [...stub.tables.values()].flat();
      assert.ok(stored.length >= 2, "the connections are stored somewhere");
      for (const row of stored) {
        assert.equal(JSON.stringify(row).includes(octocatToken), false, "a raw token reached the database");
      }
    });

    await check("adding a second connection does not steal the default", async () => {
      const chosen = await defaultGithubConnection(auth, uid);
      assert.equal(chosen?.token, octocatToken);
    });

    const hubotId = connectionIdFor("hubot");

    await check("the default can be moved", async () => {
      await setDefaultConnection(auth, uid, hubotId);
      const chosen = await defaultGithubConnection(auth, uid);
      assert.equal(chosen?.token, hubotToken);
    });

    await saveGithubConnection(auth, uid, {
      token: rotatedToken,
      login: "octocat",
      scopes: "repo",
      kind: "pat",
      label: "personal",
      canReadRepos: true,
    });

    await check("reconnecting an account rotates its token instead of adding a third", async () => {
      const after = await listGithubConnections(auth, uid);
      assert.equal(after.length, 2);
      const record = await readGithubConnection(auth, uid, connectionIdFor("octocat"));
      assert.equal(record?.token, rotatedToken);
    });

    await deleteGithubConnection(auth, uid, hubotId);

    await check("removing the default promotes the one that is left", async () => {
      const remaining = await listGithubConnections(auth, uid);
      assert.equal(remaining.length, 1);
      const chosen = await defaultGithubConnection(auth, uid);
      assert.equal(chosen?.token, rotatedToken);
    });

    await check("another account sees no connections", async () => {
      assert.deepEqual(await listGithubConnections(auth, "uid-2"), []);
    });

    await check("a connection id that is not ours reads as nothing", async () => {
      assert.equal(await readGithubConnection(auth, uid, "../escape"), null);
    });
  } finally {
    stub.restore();
  }

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
