// ── Model keys an account brings itself ─────────────────────────────────────
//
// A key is a credential, so it is stored the way the GitHub token is stored: it
// is sealed with AES-256-GCM under the deployment's 32-byte key
// (lib/github/crypto.ts) before it reaches a row, and the row is read back only
// by the account that wrote it — with that account's own token, so row-level
// security is the judge, exactly as it is for every other table here.
//
// The browser never receives a key again. It asks for a list, and a list is a
// four-character hint. That is what makes the feature safe to offer at all: a
// stolen session can replace a key, and cannot read one.
//
// Where a key is used is decided by the route that talks to the vendor: the
// chat route and the repository agent ask for this account's keys and prefer
// them over the deployment's. Nothing else in the product can see them.

import { seal, tokenKey, unseal } from "./github/crypto";
import { clientForToken } from "./supabase";
import {
  keyHint,
  USER_KEY_LABELS,
  type StoredKeySummary,
  type UserKeyProvider,
} from "./providerKeyState";
import type { ProviderFamily } from "./providers";

/** The most a provider check may take before it is reported as unreachable. */
const VALIDATION_TIMEOUT_MS = 8_000;

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

function ms(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Whether this deployment can store a key at all.
 *
 * Sealing needs the same 32-byte key the GitHub store uses. Without it there is
 * no honest way to keep a credential — plaintext would be worse than refusing —
 * so the settings screen says so instead of offering a field that cannot work.
 */
export function providerKeyStoreConfigured(): boolean {
  return tokenKey() !== null;
}

/** The keys this account has stored. Never the keys themselves. */
export async function listUserKeys(
  authorization: string | null,
  uid: string
): Promise<StoredKeySummary[]> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return [];
  try {
    const { data, error } = await client
      .from("provider_keys")
      .select("provider, hint, updated_at")
      .eq("owner", uid)
      .order("provider", { ascending: true });
    if (error || !data) return [];
    return (data as Record<string, unknown>[])
      .map((row) => {
        const provider = row.provider;
        if (typeof provider !== "string") return null;
        return {
          provider: provider as UserKeyProvider,
          hint: typeof row.hint === "string" ? row.hint : "••••",
          updatedAt: ms(row.updated_at),
        };
      })
      .filter((row): row is StoredKeySummary => row !== null);
  } catch {
    return [];
  }
}

/**
 * The account's keys, opened for one request.
 *
 * Server-only and per request: the returned strings are the credentials, so they
 * must not be serialised, logged or put in a response. A key that cannot be
 * opened (a rotated deployment key, a tampered row) is simply absent, which
 * degrades to the deployment's own key rather than failing the turn.
 */
export async function readUserKeys(
  authorization: string | null,
  uid: string
): Promise<Partial<Record<ProviderFamily, string>>> {
  const key = tokenKey();
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!key || !client || !uid) return {};
  try {
    const { data, error } = await client
      .from("provider_keys")
      .select("provider, sealed")
      .eq("owner", uid);
    if (error || !data) return {};
    const opened: Partial<Record<ProviderFamily, string>> = {};
    for (const row of data as Record<string, unknown>[]) {
      const provider = typeof row.provider === "string" ? row.provider : "";
      const sealed = typeof row.sealed === "string" ? row.sealed : "";
      if (!provider || !sealed) continue;
      const plaintext = unseal(sealed, key);
      if (plaintext) opened[provider as ProviderFamily] = plaintext;
    }
    return opened;
  } catch {
    return {};
  }
}

/** Writes or replaces one key. False means the deployment or the database refused. */
export async function saveUserKey(
  authorization: string | null,
  uid: string,
  provider: UserKeyProvider,
  plaintext: string
): Promise<boolean> {
  const key = tokenKey();
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!key || !client || !uid || !plaintext) return false;
  try {
    const { error } = await client.from("provider_keys").upsert(
      {
        owner: uid,
        provider,
        sealed: seal(plaintext, key),
        hint: keyHint(plaintext),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner,provider" }
    );
    return !error;
  } catch {
    return false;
  }
}

/** Removes one key. False means the database refused (already gone counts as removed). */
export async function deleteUserKey(
  authorization: string | null,
  uid: string,
  provider: UserKeyProvider
): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    const { error } = await client
      .from("provider_keys")
      .delete()
      .eq("owner", uid)
      .eq("provider", provider);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Asks the vendor whether a key works.
 *
 * A key that is saved without being checked is a key the person discovers is
 * wrong when an answer fails, so the check runs before the seal. The request is
 * the smallest one each vendor offers: a list, never a model call, so checking
 * costs nothing.
 *
 * The returned sentence never contains the key: it is rendered in Settings.
 */
export async function validateProviderKey(
  provider: UserKeyProvider,
  key: string
): Promise<{ ok: boolean; message: string }> {
  const label = USER_KEY_LABELS[provider];
  const request: { url: string; headers: Record<string, string> } =
    provider === "openrouter"
      ? { url: "https://openrouter.ai/api/v1/key", headers: { Authorization: `Bearer ${key}` } }
      : provider === "gemini"
        ? { url: "https://generativelanguage.googleapis.com/v1beta/models", headers: { "x-goog-api-key": key } }
        : provider === "deepseek"
          ? { url: "https://api.deepseek.com/models", headers: { Authorization: `Bearer ${key}` } }
          : { url: "https://api.groq.com/openai/v1/models", headers: { Authorization: `Bearer ${key}` } };

  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers: request.headers,
      cache: "no-store",
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, message: `${label} accepted the key.` };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `${label} refused that key. Check that it was copied whole and is still active.` };
    }
    if (response.status === 429) {
      return { ok: false, message: `${label} is rate-limiting checks right now. Try saving again in a minute.` };
    }
    return { ok: false, message: `${label} answered ${response.status} instead of accepting the key.` };
  } catch {
    return { ok: false, message: `Could not reach ${label} to check the key. Try again.` };
  }
}
