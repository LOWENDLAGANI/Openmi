// ── Openmi — tests for keys an account brings itself ────────────────────────
//
// The rules worth pinning are the ones that decide whether a credential can leak
// or be stored uselessly: what a key may look like before it is sent to a
// vendor, what the interface is allowed to show of a stored one, and where the
// route and the chat path read it. The seal itself is pinned by
// tests/repo-agent.test.ts (AES-256-GCM round trip and tamper rejection), so it
// is not re-tested through this surface.
//
//   bun run test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  keyHint,
  keyProblem,
  keySourceLabel,
  USER_KEY_HELP,
  USER_KEY_LABELS,
  USER_KEY_PROVIDERS,
  type UserKeyProvider,
} from "../lib/providerKeyState";

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
    console.log(`       ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

/** Source with comments removed, so prose cannot satisfy a code assertion. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const VALID: Record<UserKeyProvider, string> = {
  openrouter: `sk-or-v1-${"a".repeat(40)}`,
  gemini: `AIza${"b".repeat(35)}`,
  groq: `gsk_${"c".repeat(40)}`,
  deepseek: `sk-${"d".repeat(40)}`,
};

console.log("\nthe key an account brings");

test("each provider has a name, a purpose and somewhere to get a key", () => {
  for (const provider of USER_KEY_PROVIDERS) {
    assert.ok(USER_KEY_LABELS[provider].length > 0, `${provider} needs a label`);
    assert.ok(USER_KEY_HELP[provider].length > 0, `${provider} needs a one-line purpose`);
  }
});

test("a well-formed key for its own provider is accepted", () => {
  for (const provider of USER_KEY_PROVIDERS) {
    assert.equal(keyProblem(provider, VALID[provider]), null);
  }
});

test("a key pasted into the wrong provider is caught before a request", () => {
  assert.match(keyProblem("gemini", VALID.groq) ?? "", /start with AIza/);
  assert.match(keyProblem("groq", VALID.openrouter) ?? "", /start with gsk_/);
  assert.match(keyProblem("openrouter", VALID.gemini) ?? "", /start with sk-or-/);
});

test("empty, split and short pastes are refused with a reason", () => {
  assert.match(keyProblem("groq", "   ") ?? "", /Paste the key/);
  assert.match(keyProblem("groq", `gsk_${"c".repeat(10)} ${"c".repeat(10)}`) ?? "", /spaces/);
  assert.match(keyProblem("groq", "gsk_short") ?? "", /too short/);
  assert.match(keyProblem("groq", `gsk_${"c".repeat(600)}`) ?? "", /longer than/);
});

test("a stored key is only ever recognised, never repeated", () => {
  assert.equal(keyHint(VALID.groq), "••••cccc");
  assert.equal(keyHint("short"), "••••");
  assert.doesNotMatch(keyHint(VALID.openrouter), /sk-or/);
});

test("the row says whether the key is the account's, the deployment's or absent", () => {
  assert.match(keySourceLabel("account", "••••cccc"), /Your key ••••cccc/);
  assert.match(keySourceLabel("deployment"), /deployment/);
  assert.match(keySourceLabel("missing"), /No key/);
});

console.log("\nwhere a stored key is used");

test("the keys route verifies the caller and refuses a cross-origin write", () => {
  const source = code("app/api/keys/route.ts");
  assert.match(source, /verifyCaller\(/);
  assert.match(source, /isSameOriginRequest\(/);
  assert.match(source, /providerKeyStoreConfigured\(\)/);
  // Never read a uid out of the request: the row is the caller's own.
  assert.doesNotMatch(source, /body\.uid|searchParams\.get\("uid"\)/);
  // The save answers with a hint, never with the key it just stored.
  assert.match(source, /keyHint\(key\)/);
  assert.doesNotMatch(source, /sealed: key/);
  assert.doesNotMatch(source, /key: key[,}\s]/);
});

test("a key is checked with the provider before it is sealed", () => {
  const route = code("app/api/keys/route.ts");
  const validateAt = route.indexOf("validateProviderKey(body.provider, key)");
  const saveAt = route.indexOf("saveUserKey(authorization, identity.uid, body.provider, key)");
  assert.ok(validateAt > 0 && saveAt > 0, "both steps must exist");
  assert.ok(validateAt < saveAt, "nothing sealed is written until the vendor says the key works");

  const keys = code("lib/providerKeys.ts");
  assert.match(keys, /seal\(plaintext, key\)/);
  assert.match(keys, /unseal\(sealed, key\)/);
});

test("every provider is validated against its own endpoint", () => {
  const keys = code("lib/providerKeys.ts");
  assert.match(keys, /openrouter\.ai\/api\/v1\/key/);
  assert.match(keys, /generativelanguage\.googleapis\.com/);
  assert.match(keys, /api\.groq\.com\/openai\/v1\/models/);
  assert.match(keys, /api\.deepseek\.com\/models/);
});

test("chat, the mode picker and the agent all prefer the account's key", () => {
  const providers = code("lib/providers.ts");
  assert.match(providers, /accountKeys\.openrouter/, "the account's key must win");
  assert.match(providers, /\|\| process\.env\.OPENROUTER_API_KEY/, "the deployment's stays the fallback");

  const chat = code("app/api/chat/route.ts");
  assert.match(chat, /readUserKeys\(authorization, identity\.uid\)/);
  assert.match(chat, /getProviders\(requested, accountKeys\)/);
  assert.match(chat, /getProviders\(mode, accountKeys\)|accountKeys\.groq/);

  const step = code("app/api/agent/step/route.ts");
  assert.match(step, /readUserKeys\(authorization, identity\.uid\)/);
  assert.match(step, /accountKeys/);
});

test("the table is owner-scoped in the schema and registered with the audit", () => {
  const sql = read("supabase/migrations/20261026000000_provider_keys.sql");
  assert.match(sql, /create table if not exists public\.provider_keys/);
  assert.match(sql, /provider_keys_owner on public\.provider_keys[\s\S]*using \(owner = auth\.uid\(\)\)/);
  assert.match(sql, /with check \(owner = auth\.uid\(\)\)/);
  assert.equal(/provider_keys_admin/.test(sql), false, "the administrator has no branch here");
  assert.match(sql, /insert into public\.schema_expected[\s\S]*provider_keys/);
});

test("erasing an account's data erases its keys", () => {
  assert.match(code("lib/privacy.ts"), /"provider_keys"/);
});

console.log(`\nprovider keys: ${passes} passed${failures > 0 ? `, ${failures} failed` : ""}`);
if (failures > 0) process.exit(1);
