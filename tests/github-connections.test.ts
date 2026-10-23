// ── Openmi — the GitHub connection collection ────────────────────────────────
//
// The storage module reads its database address and its sealing key from the
// environment *when it is imported*, so this file sets both before the first
// dynamic import. That is why it lives in its own suite: the rest of the tests
// deliberately run with no deployment configured.
//
// The only thing stubbed is the Realtime Database itself. Sealing, unsealing,
// the default pointer and replacement-on-reconnect are the real code.
//
//   bun run test

import assert from "node:assert/strict";

const OAUTH_KEY = "9f".repeat(32);
process.env.GITHUB_TOKEN_KEY = OAUTH_KEY;
process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL = "https://openmi.test";

/** An in-memory stand-in for the REST endpoints `writeAsCaller` uses. */
function installDatabaseStub(): { rows: Map<string, string>; restore: () => void } {
  const rows = new Map<string, string>();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/\.json$/, "").replace(/^\//, "");
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      rows.set(path, String(init?.body ?? "null"));
      return new Response("null", { status: 200 });
    }
    if (method === "DELETE") {
      rows.delete(path);
      return new Response("null", { status: 200 });
    }
    const exact = rows.get(path);
    if (exact !== undefined) return new Response(exact, { status: 200 });

    // A real database answers a parent read with its children nested, which is
    // exactly what listing the collection relies on.
    const descendants = [...rows.entries()].filter(([key]) => key.startsWith(`${path}/`));
    if (descendants.length === 0) return new Response("null", { status: 200 });
    const root: Record<string, unknown> = {};
    for (const [key, body] of descendants) {
      const segments = key.slice(path.length + 1).split("/");
      let node: Record<string, unknown> = root;
      for (const segment of segments.slice(0, -1)) {
        const next = node[segment];
        if (!next || typeof next !== "object") node[segment] = {};
        node = node[segment] as Record<string, unknown>;
      }
      node[segments[segments.length - 1]!] = JSON.parse(body);
    }
    return new Response(JSON.stringify(root), { status: 200 });
  }) as typeof fetch;
  return {
    rows,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

(async () => {
  const { connectionIdFor } = await import("../lib/github/pat");
  const {
    defaultGithubConnection,
    deleteGithubConnection,
    listGithubConnections,
    readGithubConnection,
    saveGithubConnection,
    setDefaultConnection,
  } = await import("../lib/github/connections");

  const stub = installDatabaseStub();

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
      assert.equal(stub.rows.size >= 3, true, "the token is stored somewhere, sealed");
      for (const value of stub.rows.values()) assert.equal(value.includes(octocatToken), false);
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
