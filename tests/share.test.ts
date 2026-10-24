// ── Tests for shared answers ─────────────────────────────────────────────────
//
// A share is the one page a signed-out stranger can read. Two things therefore
// matter more than the UI: what a snapshot is allowed to contain, and that the
// public projection cannot carry the owner's identity or outlive revocation.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARE_MAX_CHARS,
  SHARE_MAX_MESSAGES,
  SHARE_TTL_DAYS,
  buildShareSnapshot,
  isShareId,
  parseSharedMessages,
  shareErrorMessage,
  shareUrl,
} from "../lib/share";

// ── What may be published ───────────────────────────────────────────────────

const valid = buildShareSnapshot({
  title: "  How does auth work?  ",
  messages: [
    { role: "user", content: "  How does auth work?  " },
    { role: "assistant", content: "It uses Supabase Auth." },
  ],
});
assert.ok(valid);
assert.equal(valid.title, "How does auth work?");
assert.deepEqual(valid.messages, [
  { role: "user", content: "How does auth work?" },
  { role: "assistant", content: "It uses Supabase Auth." },
]);

// The title is optional and falls back to the first line of the question.
const untitled = buildShareSnapshot({ messages: [{ role: "user", content: "First line\nsecond line" }] });
assert.ok(untitled);
assert.equal(untitled.title, "First line");
assert.equal(untitled.title.length <= 120, true);

// A long title is cut, not rejected: the text is what matters.
const longTitle = buildShareSnapshot({
  title: "x".repeat(500),
  messages: [{ role: "assistant", content: "Answer" }],
});
assert.ok(longTitle);
assert.equal(longTitle.title.length, 120);

// Empty placeholders are dropped, but a snapshot with nothing left is refused.
assert.equal(
  buildShareSnapshot({ messages: [{ role: "assistant", content: "   " }] }),
  null
);
assert.deepEqual(
  buildShareSnapshot({
    messages: [
      { role: "assistant", content: "" },
      { role: "assistant", content: "Real answer" },
    ],
  })?.messages,
  [{ role: "assistant", content: "Real answer" }]
);

// System messages are never published, and malformed bodies are refused.
assert.equal(buildShareSnapshot({ messages: [{ role: "system", content: "secret" }] }), null);
assert.equal(buildShareSnapshot({ messages: "nope" }), null);
assert.equal(buildShareSnapshot(null), null);
assert.equal(buildShareSnapshot({}), null);
assert.equal(buildShareSnapshot({ messages: [] }), null);
assert.equal(
  buildShareSnapshot({
    messages: Array.from({ length: SHARE_MAX_MESSAGES + 1 }, () => ({ role: "assistant", content: "a" })),
  }),
  null
);
assert.equal(
  buildShareSnapshot({ messages: [{ role: "assistant", content: "a".repeat(SHARE_MAX_CHARS + 1) }] }),
  null
);

// ── Reading a stored snapshot ───────────────────────────────────────────────

assert.deepEqual(
  parseSharedMessages([
    { role: "user", content: "Q" },
    { role: "system", content: "not published" },
    { role: "assistant", content: "A" },
    { role: "assistant", content: "   " },
    null,
  ]),
  [
    { role: "user", content: "Q" },
    { role: "assistant", content: "A" },
  ]
);
assert.deepEqual(parseSharedMessages("nope"), []);

// ── Links ───────────────────────────────────────────────────────────────────

assert.equal(isShareId("0123456789abcdef0123456789abcdef"), true);
assert.equal(isShareId("0123456789ABCDEF0123456789ABCDEF"), false);
assert.equal(isShareId("short"), false);
assert.equal(isShareId("../../etc/passwd"), false);
assert.equal(shareUrl("https://openmi.example/", "0123456789abcdef"),
  "https://openmi.example/share/0123456789abcdef");
assert.equal(SHARE_TTL_DAYS, 30);
assert.match(shareErrorMessage({ code: "PGRST205" }), /not set up/);
assert.equal(shareErrorMessage({ message: "Sign in to share an answer." }), "Sign in to share an answer.");

// ── The database's privacy shape ────────────────────────────────────────────

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/20261024000700_shares.sql"),
  "utf8"
);

assert.match(sql, /create table if not exists public\.shared_chats/);
assert.match(sql, /owner uuid not null default auth\.uid\(\)/);
assert.match(sql, /on delete cascade/);
assert.match(sql, /create or replace view public\.shared_public/);
assert.ok(sql.includes("'shared_public', 'view'"), "the audit must know the public projection");
assert.ok(/when 'view' then to_regclass/.test(sql), "the audit must check views like tables");
assert.ok(
  /select id, title, messages, created_at, expires_at/.test(sql),
  "the public view must not expose the owner"
);
assert.ok(
  /where not revoked[\s\S]*expires_at > now\(\)/.test(sql),
  "a revoked or expired link must disappear from the view"
);
assert.ok(
  /grant select on public\.shared_public to anon, authenticated/.test(sql),
  "a stranger must be able to read a link without an account"
);
assert.ok(
  /grant select, insert, update, delete on public\.shared_chats to authenticated/.test(sql),
  "the owner needs the base table to manage their links"
);
assert.ok(
  /create policy shared_chats_owner on public\.shared_chats[\s\S]*using \(owner = auth\.uid\(\)\)/.test(sql),
  "a share is only the owner's row"
);

// ── The API is the only writer ──────────────────────────────────────────────

const createRoute = readFileSync(join(process.cwd(), "app/api/share/route.ts"), "utf8");
assert.match(createRoute, /verifyCaller\(authorization\)/);
assert.match(createRoute, /buildShareSnapshot\(body\)/);
assert.match(createRoute, /owner: identity\.uid/);
assert.match(createRoute, /randomUUID\(\)/);
assert.ok(
  !/owner:\s*(body|snapshot)/.test(createRoute),
  "the owner must come from the verified identity, never the body"
);

const revokeRoute = readFileSync(join(process.cwd(), "app/api/share/[id]/route.ts"), "utf8");
assert.match(revokeRoute, /verifyCaller\(authorization\)/);
assert.ok(
  /\.update\(\{ revoked: true \}\)[\s\S]*\.eq\("id", id\)[\s\S]*\.eq\("owner", identity\.uid\)/.test(revokeRoute),
  "revoking must be scoped to the caller's own row"
);

console.log("share: all checks passed");
