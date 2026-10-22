// ── Where a GitHub connection lives ─────────────────────────────────────────
//
// The access token is written to `users/{uid}/github` sealed with the
// deployment's key (lib/github/crypto.ts). Two properties matter:
//
//   1. The browser never receives the token again. `github/status` answers with
//      the login and the date, never the secret.
//   2. The value is written with the caller's own Firebase token, so the rules
//      decide whether it may be written — the same pattern as Dew and history.
//      A user who can write their own node can replace their own connection,
//      which is theirs to replace. They cannot read anybody else's, and what
//      they can read of their own is ciphertext.
//
// A token that cannot be decrypted is treated as "not connected" rather than as
// an error: that is exactly what happens after the key is rotated, and the
// remedy is to reconnect.

import { deleteAsCaller, readAsCaller } from "../rtdb";
import { writeAsCaller } from "../serverControl";
import { seal, tokenKey, unseal } from "./crypto";

export interface GithubLink {
  /** The access token. Server-only; never serialised into a response. */
  token: string;
  login: string;
  scopes: string;
  linkedAt: number;
}

interface StoredLink {
  v: 1;
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

const pathFor = (uid: string) => `users/${uid}/github`;

/** True when this deployment can store a connection at all. */
export function githubStoreConfigured(): boolean {
  return tokenKey() !== null;
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
  if (!key) return false;
  const stored: StoredLink = {
    v: 1,
    token: seal(link.token, key),
    login: link.login,
    scopes: link.scopes,
    linkedAt: link.linkedAt ?? Date.now(),
  };
  return writeAsCaller(authorization, pathFor(uid), stored);
}

/** Reads and opens the connection, or null when there is not a usable one. */
export async function readGithubLink(
  authorization: string | null,
  uid: string
): Promise<GithubLink | null> {
  const key = tokenKey();
  if (!key) return null;
  const stored = await readAsCaller<StoredLink>(authorization, pathFor(uid));
  if (!stored || typeof stored !== "object" || stored.v !== 1 || typeof stored.token !== "string") {
    return null;
  }
  const token = unseal(stored.token, key);
  if (!token) return null;
  return {
    token,
    login: typeof stored.login === "string" ? stored.login.slice(0, 100) : "",
    scopes: typeof stored.scopes === "string" ? stored.scopes.slice(0, 200) : "",
    linkedAt: typeof stored.linkedAt === "number" ? stored.linkedAt : 0,
  };
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
  return deleteAsCaller(authorization, pathFor(uid));
}
