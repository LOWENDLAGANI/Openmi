// ── Several GitHub connections, one account ─────────────────────────────────
//
// A person can hold more than one GitHub credential: a personal token, a token
// for a work organisation, a fine-grained token that only reaches one
// repository. Storing exactly one meant every new connection replaced the last
// one, which is why this is a collection rather than a node.
//
// The shape mirrors projects on purpose. A project is a repository pinned at a
// commit; a connection is a credential pinned to a GitHub account. Both live
// under the caller's uid, both are written with the caller's own token so the
// rules decide access, and both are listed by the interface rather than guessed
// at.
//
// ── What is stored, and what is not ─────────────────────────────────────────
// The token is sealed (AES-256-GCM, lib/github/crypto.ts) before it is written.
// The database therefore holds ciphertext, and a rotated key makes every
// connection unreadable rather than wrong — the remedy is to reconnect, which is
// the same remedy a revoked token has. No read path returns the token; the
// summary type below is the only thing that crosses into a response.
//
// A connection that cannot be opened is skipped rather than reported: one dead
// entry must not take the whole list with it.

import { deleteAsCaller, readAsCaller } from "../rtdb";
import { writeAsCaller } from "../serverControl";
import { seal, tokenKey, unseal } from "./crypto";
import { looksLikeGithubToken } from "./oauth";
import {
  connectionIdFor,
  isConnectionId,
  normalizeConnectionKind,
  normalizeConnectionLabel,
  type ConnectionKind,
} from "./pat";

export interface GithubConnection {
  id: string;
  /** The access token. Server-only; never serialised into a response. */
  token: string;
  login: string;
  /** GitHub's own scope string, or "" when it did not report one. */
  scopes: string;
  kind: ConnectionKind;
  label: string;
  linkedAt: number;
  /** Whether GitHub let this token list a repository when it was checked. */
  canReadRepos: boolean;
}

/** What the interface is allowed to see. Never includes the token. */
export interface GithubConnectionSummary {
  id: string;
  login: string;
  scopes: string;
  kind: ConnectionKind;
  label: string;
  linkedAt: number;
  canReadRepos: boolean;
}

interface StoredConnection {
  v: 1;
  token: string;
  login: string;
  scopes: string;
  kind: ConnectionKind;
  label: string;
  linkedAt: number;
  canReadRepos: boolean;
}

interface StoredDefault {
  id: string;
  at: number;
}

const connectionsPath = (uid: string) => `users/${uid}/githubConnections`;
const connectionPath = (uid: string, id: string) => `${connectionsPath(uid)}/${id}`;
const defaultPath = (uid: string) => `users/${uid}/githubDefault`;

/** True when this deployment can store a connection at all. */
export function connectionsConfigured(): boolean {
  return tokenKey() !== null;
}

function summaryOf(connection: GithubConnection): GithubConnectionSummary {
  return {
    id: connection.id,
    login: connection.login,
    scopes: connection.scopes,
    kind: connection.kind,
    label: connection.label,
    linkedAt: connection.linkedAt,
    canReadRepos: connection.canReadRepos,
  };
}

export { summaryOf as toConnectionSummary };

/** Opens one stored record. Null for anything not sealed by this deployment. */
function open(id: string, raw: unknown): GithubConnection | null {
  const key = tokenKey();
  if (!key || !isConnectionId(id)) return null;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<StoredConnection>;
  if (value.v !== 1 || typeof value.token !== "string") return null;

  const token = unseal(value.token, key);
  if (!token || !looksLikeGithubToken(token)) return null;

  return {
    id,
    token,
    login: typeof value.login === "string" ? value.login.slice(0, 100) : "",
    scopes: typeof value.scopes === "string" ? value.scopes.slice(0, 200) : "",
    kind: normalizeConnectionKind(value.kind),
    label: normalizeConnectionLabel(value.label),
    linkedAt: typeof value.linkedAt === "number" ? value.linkedAt : 0,
    canReadRepos: value.canReadRepos === true,
  };
}

/**
 * Every connection this account holds, newest first.
 *
 * A refused read is an empty list, which the caller renders as "not connected"
 * — the honest reading, because a list that could not be fetched is not a list
 * of connections the agent may use.
 */
export async function listGithubConnections(
  authorization: string | null,
  uid: string
): Promise<GithubConnectionSummary[]> {
  const stored = await readAsCaller<Record<string, unknown>>(authorization, connectionsPath(uid));
  if (!stored) return [];
  return Object.entries(stored)
    .map(([id, raw]) => open(id, raw))
    .filter((connection): connection is GithubConnection => connection !== null)
    .sort((a, b) => b.linkedAt - a.linkedAt)
    .map(summaryOf);
}

/** One connection, or null when it is not this account's or does not open. */
export async function readGithubConnection(
  authorization: string | null,
  uid: string,
  id: string
): Promise<GithubConnection | null> {
  if (!isConnectionId(id)) return null;
  const stored = await readAsCaller<unknown>(authorization, connectionPath(uid, id));
  return open(id, stored);
}

/** The id the account chose, when it has chosen one and it still exists. */
export async function readDefaultConnectionId(
  authorization: string | null,
  uid: string
): Promise<string | null> {
  const stored = await readAsCaller<StoredDefault>(authorization, defaultPath(uid));
  if (!stored || typeof stored.id !== "string" || !isConnectionId(stored.id)) return null;
  return stored.id;
}

/** Marks a connection as the one new repository reads use. */
export async function setDefaultConnection(
  authorization: string | null,
  uid: string,
  id: string
): Promise<boolean> {
  if (!isConnectionId(id)) return false;
  return writeAsCaller(authorization, defaultPath(uid), {
    id,
    at: Date.now(),
  } satisfies StoredDefault);
}

/**
 * Saves a connection, replacing any entry for the same GitHub account.
 *
 * The id comes from the login, so pasting a fresh token for an account that is
 * already connected rotates the credential instead of adding a second, and the
 * old one stops being used immediately. If the account has no default yet — the
 * first connection ever — this one becomes it, so a single-token account needs
 * to make no further choice.
 */
export async function saveGithubConnection(
  authorization: string | null,
  uid: string,
  input: {
    token: string;
    login: string;
    scopes: string;
    kind: ConnectionKind;
    label?: string;
    canReadRepos: boolean;
    linkedAt?: number;
  }
): Promise<GithubConnection | null> {
  const key = tokenKey();
  if (!key) return null;
  const login = input.login.trim().slice(0, 100);
  if (!login) return null;

  const id = connectionIdFor(login);
  const connection: GithubConnection = {
    id,
    token: input.token,
    login,
    scopes: (input.scopes ?? "").slice(0, 200),
    kind: normalizeConnectionKind(input.kind),
    label: normalizeConnectionLabel(input.label, `${login}`),
    linkedAt: input.linkedAt ?? Date.now(),
    canReadRepos: Boolean(input.canReadRepos),
  };

  const stored: StoredConnection = {
    v: 1,
    token: seal(connection.token, key),
    login: connection.login,
    scopes: connection.scopes,
    kind: connection.kind,
    label: connection.label,
    linkedAt: connection.linkedAt,
    canReadRepos: connection.canReadRepos,
  };

  const written = await writeAsCaller(authorization, connectionPath(uid, id), stored);
  if (!written) return null;

  // The default is a convenience, never a requirement: a failed write here
  // leaves the connection usable, because `defaultGithubConnection` falls back
  // to the newest entry when the pointer is missing.
  const currentDefault = await readDefaultConnectionId(authorization, uid);
  if (!currentDefault) await setDefaultConnection(authorization, uid, id);

  return connection;
}

/** Removes one connection, and the pointer to it if it was the default. */
export async function deleteGithubConnection(
  authorization: string | null,
  uid: string,
  id: string
): Promise<boolean> {
  if (!isConnectionId(id)) return false;
  const removed = await deleteAsCaller(authorization, connectionPath(uid, id));
  const currentDefault = await readDefaultConnectionId(authorization, uid);
  if (currentDefault === id) {
    await deleteAsCaller(authorization, defaultPath(uid));
    // Another connection may remain. Promoting the newest keeps repository
    // reads working without the person having to pick again after a removal.
    const remaining = await listGithubConnections(authorization, uid);
    if (remaining[0]) await setDefaultConnection(authorization, uid, remaining[0].id);
  }
  return removed;
}

/** Renames one connection. Returns the updated summary, or null. */
export async function renameGithubConnection(
  authorization: string | null,
  uid: string,
  id: string,
  label: string
): Promise<GithubConnectionSummary | null> {
  const existing = await readGithubConnection(authorization, uid, id);
  if (!existing) return null;
  const saved = await saveGithubConnection(authorization, uid, {
    token: existing.token,
    login: existing.login,
    scopes: existing.scopes,
    kind: existing.kind,
    label,
    canReadRepos: existing.canReadRepos,
    linkedAt: existing.linkedAt,
  });
  return saved ? summaryOf(saved) : null;
}

/**
 * The connection a repository read should use.
 *
 * The default first, then the newest, and null only when the account holds
 * none. Falling back to the newest matters after a key rotation or a partial
 * write: a missing pointer must not read as "not connected" while a perfectly
 * usable token is sitting right there.
 */
export async function defaultGithubConnection(
  authorization: string | null,
  uid: string
): Promise<GithubConnection | null> {
  const chosen = await readDefaultConnectionId(authorization, uid);
  if (chosen) {
    const connection = await readGithubConnection(authorization, uid, chosen);
    if (connection) return connection;
  }
  const list = await listGithubConnections(authorization, uid);
  if (list.length === 0) return null;
  return readGithubConnection(authorization, uid, list[0]!.id);
}
