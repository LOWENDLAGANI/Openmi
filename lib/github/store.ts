// ── Where a GitHub connection lives ─────────────────────────────────────────
//
// The access token is stored in the `github_links` row for the caller, sealed
// with the deployment's key (lib/github/crypto.ts). Two properties matter:
//
//   1. The browser never receives the token again. `github/status` answers with
//      the login and the date, never the secret.
//   2. The row is written with the caller's own token, so the policies decide
//      whether it may be written — the same pattern as Dew and history. A user
//      who can write their own row can replace their own connection, which is
//      theirs to replace. They cannot read anybody else's, and what they can read
//      of their own is ciphertext.
//
// A token that cannot be decrypted is treated as "not connected" rather than as
// an error: that is exactly what happens after the key is rotated, and the
// remedy is to reconnect.

import { clientForToken } from "../supabase";
import { defaultGithubConnection } from "./connections";
import { seal, tokenKey, unseal } from "./crypto";
import { looksLikeGithubToken } from "./oauth";

export interface GithubLink {
  /** The access token. Server-only; never serialised into a response. */
  token: string;
  login: string;
  scopes: string;
  linkedAt: number;
}

/** What the status route is allowed to say. */
export interface GithubLinkSummary {
  login: string;
  scopes: string;
  linkedAt: number;
}

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
 * Where a connection made through GitHub's own OAuth App lives.
 *
 * The token-paste flow can write to the database under the caller's uid,
 * because the browser still holds a session token when it posts the result.
 * The OAuth callback is a top-level navigation back from github.com and has no
 * bearer token at all, so it cannot write there. The token is sealed into an
 * httpOnly cookie instead: still encrypted with the deployment key, still never
 * read by the browser, and bound to one uid inside the sealed payload so a
 * cookie from another account is ignored rather than used.
 */
export const GITHUB_CONNECTION_COOKIE = "openmi_github";

/** Thirty days, matching how long a GitHub connection is worth keeping. */
export const GITHUB_CONNECTION_MAX_AGE_S = 30 * 24 * 60 * 60;

/** True when this deployment can store a connection at all. */
export function githubStoreConfigured(): boolean {
  return tokenKey() !== null;
}

// ── The sealed connection cookie ─────────────────────────────────────────────

interface StoredCookie {
  v: 1;
  uid: string;
  token: string;
  login: string;
  scopes: string;
  linkedAt: number;
}

/** Seals a connection for one uid. Null when the deployment has no key. */
export function sealGithubConnection(
  link: GithubLink,
  uid: string
): string | null {
  const key = tokenKey();
  if (!key || !uid) return null;
  const payload: StoredCookie = {
    v: 1,
    uid,
    token: link.token,
    login: link.login.slice(0, 100),
    scopes: link.scopes.slice(0, 200),
    linkedAt: link.linkedAt || Date.now(),
  };
  return seal(JSON.stringify(payload), key);
}

/**
 * Opens a connection cookie for the uid that is asking.
 *
 * Null covers every way this can be wrong — not a value this deployment sealed,
 * a rotated key, a tampered payload — and one that matters more than the rest:
 * a cookie sealed for a different uid. Reading that as "connected" would hand
 * one account's GitHub access to another account's session.
 */
export function openGithubConnection(
  value: string | null | undefined,
  uid: string
): GithubLink | null {
  const key = tokenKey();
  if (!key || !value || !uid) return null;
  const opened = unseal(value, key);
  if (!opened) return null;
  let payload: StoredCookie;
  try {
    payload = JSON.parse(opened) as StoredCookie;
  } catch {
    return null;
  }
  if (!payload || payload.v !== 1) return null;
  if (payload.uid !== uid) return null;
  if (!looksLikeGithubToken(payload.token)) return null;
  return {
    token: payload.token,
    login: typeof payload.login === "string" ? payload.login.slice(0, 100) : "",
    scopes: typeof payload.scopes === "string" ? payload.scopes.slice(0, 200) : "",
    linkedAt: typeof payload.linkedAt === "number" ? payload.linkedAt : 0,
  };
}

/** The minimum a route needs to read its own connection cookie. */
export interface RequestWithCookies {
  cookies: { get(name: string): { value: string } | undefined };
}

/**
 * The connection a request may use, from any of the three stores.
 *
 * Order matters, and it is "most specific to least":
 *
 *   1. The sealed OAuth cookie. It belongs to this browser and was sealed for
 *      this uid, so nothing else can be more specific.
 *   2. The account's connection collection, which is what a pasted personal
 *      access token creates. The default entry is chosen, falling back to the
 *      newest, so an account with several tokens still has one answer.
 *   3. The legacy single node, kept so a connection made before the collection
 *      existed does not break.
 *
 * Every step is scoped to the verified uid, and a cookie sealed for someone
 * else falls through rather than being used.
 */
export async function resolveGithubLink(
  req: RequestWithCookies,
  authorization: string | null,
  uid: string
): Promise<GithubLink | null> {
  const cookieValue = req.cookies.get(GITHUB_CONNECTION_COOKIE)?.value;
  if (cookieValue) {
    const fromCookie = openGithubConnection(cookieValue, uid);
    if (fromCookie) return fromCookie;
    console.error(`[github] OAuth cookie present but could not be opened for uid ${uid}`);
  }

  const stored = await defaultGithubConnection(authorization, uid);
  if (stored) {
    return {
      token: stored.token,
      login: stored.login,
      scopes: stored.scopes,
      linkedAt: stored.linkedAt,
    };
  }

  const legacy = await readGithubLink(authorization, uid);
  if (legacy) return legacy;
  if (cookieValue) {
    console.error(`[github] failed to resolve GitHub link for uid ${uid} — cookie present but unreadable, no default connection, no legacy link`);
  }
  return null;
}

/**
 * Saves a connection. Returns false when the deployment has no key or the
 * database refused the write — the route turns that into a setup message
 * rather than pretending the connection worked.
 */
export async function saveGithubLink(
  authorization: string | null,
  uid: string,
  link: Omit<GithubLink, "linkedAt"> & { linkedAt?: number }
): Promise<boolean> {
  const key = tokenKey();
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!key || !client || !uid) return false;

  const linkedAt = link.linkedAt ?? Date.now();
  try {
    const { error } = await client.from("github_links").upsert(
      {
        owner: uid,
        token: seal(link.token, key),
        login: link.login.slice(0, 100),
        scopes: link.scopes.slice(0, 200),
        linked_at: new Date(linkedAt).toISOString(),
      },
      { onConflict: "owner" }
    );
    return !error;
  } catch {
    return false;
  }
}

/** Reads and opens the connection, or null when there is not a usable one. */
export async function readGithubLink(
  authorization: string | null,
  uid: string
): Promise<GithubLink | null> {
  const key = tokenKey();
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!key || !client || !uid) return null;
  try {
    const { data, error } = await client
      .from("github_links")
      .select("token, login, scopes, linked_at")
      .eq("owner", uid)
      .maybeSingle();
    if (error || !data || typeof data.token !== "string") return null;

    const opened = unseal(data.token, key);
    if (!opened) return null;
    return {
      token: opened,
      login: typeof data.login === "string" ? data.login.slice(0, 100) : "",
      scopes: typeof data.scopes === "string" ? data.scopes.slice(0, 200) : "",
      linkedAt: ms(data.linked_at),
    };
  } catch {
    return null;
  }
}

/** The summary the browser is allowed to see. Never includes the token. */
export async function readGithubSummary(
  authorization: string | null,
  uid: string
): Promise<GithubLinkSummary | null> {
  const link = await readGithubLink(authorization, uid);
  if (!link) return null;
  return { login: link.login, scopes: link.scopes, linkedAt: link.linkedAt };
}

/** Removes the connection. */
export async function clearGithubLink(authorization: string | null, uid: string): Promise<boolean> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client || !uid) return false;
  try {
    const { error } = await client.from("github_links").delete().eq("owner", uid);
    return !error;
  } catch {
    return false;
  }
}
