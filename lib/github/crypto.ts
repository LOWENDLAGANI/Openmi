// ── Secrets, sealed and verified ─────────────────────────────────────────────
//
// Two different jobs, one module, because both are "a server-only key the
// browser must never learn":
//
//   1. A GitHub access token is sealed with AES-256-GCM before it is written to
//      the database. The database rules let the owner read their own ciphertext;
//      without the key that is all it is. The key never leaves the server.
//   2. A turn's state is signed with HMAC-SHA256, so the client can carry it
//      between steps without being able to forge how many steps it has used or
//      whether it has paid. This is how a stateless endpoint still enforces a
//      budget: the budget lives in a blob the client cannot alter.
//
// Both functions are pure and take the key as an argument, so tests can pin the
// round-trip and the tamper rejection without touching the environment.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PREFIX = "v1";

/** Reads the 32-byte hex key from the environment, or null when unset/invalid. */
export function keyFromEnv(value: string | undefined): Buffer | null {
  const hex = value?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** The deployment's GitHub token key. Null means GitHub cannot be connected. */
export function tokenKey(): Buffer | null {
  return keyFromEnv(process.env.GITHUB_TOKEN_KEY);
}

/**
 * The key a turn token is signed with.
 *
 * `AGENT_TURN_SECRET` is the intended setting. Falling back to the GitHub token
 * key keeps a single-secret deployment working, and a per-process random key
 * keeps development working with no configuration at all — at the cost that a
 * turn cannot span two instances. That trade is stated rather than hidden:
 * production sets one of the two.
 */
const processFallback = randomBytes(KEY_BYTES);
export const turnSecretIsConfigured = Boolean(
  process.env.AGENT_TURN_SECRET?.trim() || process.env.GITHUB_TOKEN_KEY?.trim()
);

export function turnKey(): Buffer {
  const configured = keyFromEnv(process.env.AGENT_TURN_SECRET);
  if (configured) return configured;
  const borrowed = keyFromEnv(process.env.GITHUB_TOKEN_KEY);
  if (borrowed) return borrowed;
  return processFallback;
}

/** Seals a UTF-8 string. Output: `v1.<iv>.<tag>.<ciphertext>`, base64url. */
export function seal(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error("seal: key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/**
 * Opens a sealed string. Returns null for anything that is not a value this
 * module produced with this key: a truncated blob, a different key, or a
 * tampered ciphertext. A null is treated by callers as "not connected".
 */
export function unseal(payload: string, key: Buffer): string | null {
  if (key.length !== KEY_BYTES) return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const ciphertext = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // A failed GCM tag is a refusal, not an error worth surfacing: it means the
    // value was not sealed by this deployment.
    return null;
  }
}

/** Signs an arbitrary payload. Output: `<body>.<signature>`, base64url. */
export function sign<T>(payload: T, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

/**
 * Verifies and parses a signed payload. Null on a bad shape, a bad signature,
 * or anything that is not valid JSON — never a partial object.
 */
export function verify<T>(token: string, key: Buffer): T | null {
  const split = token.lastIndexOf(".");
  if (split <= 0) return null;
  const body = token.slice(0, split);
  const signature = token.slice(split + 1);
  const expected = createHmac("sha256", key).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
