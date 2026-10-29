"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { AgentStep, Chat, ChatFolder, ChatMessage } from "./types";
import type { TrashEntry } from "./trash";
import { displayedContent } from "./variants";
import { DEFAULT_MODE_ID, OPENMI_MODES, type ModeId } from "./models";

// ── The chat session cache ───────────────────────────────────────────────────
//
// Chat history lives on the server. This module is the tab's view of it for as
// long as the tab is open — nothing here is written to IndexedDB, localStorage
// or any other durable store on the device.
//
// That is a deliberate reversal. History used to be created in IndexedDB first
// and copied to the account afterwards, which meant every browser accumulated a
// second, private copy of every conversation: a copy that survived sign-out,
// that a different account on the same device could see for a moment during the
// handover, and that could not be trusted as the current answer once two devices
// disagreed. The account is now the only copy. A reload starts from the server,
// a new browser starts from the server, and nothing about a conversation stays
// behind on a machine after the tab closes.
//
// The sync partner is `lib/cloudHistory.ts`: it pulls the account's chats,
// folders and trash into this cache when a session starts, and pushes each write
// back. Its merge logic is unchanged — the change is only that the cache it
// merges into is memory, so a failed write is a failed write rather than a
// silent local copy that pretends the server agreed.
//
// ── What this is not ────────────────────────────────────────────────────────
// It is not an offline store. With no network there is no history to read, and
// an unsent message is an error the person can see rather than a row waiting for
// the next sync. `exportBackup` still produces a file from whatever is loaded,
// which is the honest shape of a backup when the device holds nothing.

/** A repository turn that was still running when the tab went away. */
export interface AgentRunRecord {
  /** The assistant message the turn is writing into. */
  id: string;
  chatId: string;
  projectId: string;
  /** The loop's own wire state, so step N+1 can be asked for after a reload. */
  transcript: unknown[];
  turnToken: string;
  /** The turn's attached text, re-sent with every step. */
  context: string;
  content: string;
  steps: AgentStep[];
  /**
   * The server-side run this message is following.
   *
   * The run — its transcript, token and budget — lives in `agent_runs`, so this
   * record is only the pointer that says which message to render it into.
   */
  runId?: string;
  updatedAt: number;
}

/** Anything this cache stores has a primary key. */
interface Identified {
  id: string;
}

// ── Reactivity ───────────────────────────────────────────────────────────────
// One version counter for the whole cache. Every mutation bumps it, and every
// live query re-runs. That is coarse on purpose: the alternative is per-table
// dependency tracking, and the cost of re-running a few in-memory filters after
// a write is smaller than the bug surface of getting the tracking wrong.

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function currentVersion(): number {
  return version;
}

/** The subset of the old collection API the app actually calls. */
class Collection<T extends Identified> {
  private readonly orderField: string | null;
  private reverseOrder = false;
  private limitCount: number | null = null;

  constructor(
    private readonly table: Table<T>,
    private readonly predicate: (row: T) => boolean = () => true,
    orderField: string | null = null
  ) {
    this.orderField = orderField;
  }

  private clone(): Collection<T> {
    const next = new Collection<T>(this.table, this.predicate, this.orderField);
    next.reverseOrder = this.reverseOrder;
    next.limitCount = this.limitCount;
    return next;
  }

  private rows(): T[] {
    let list = this.table.snapshot().filter(this.predicate);
    if (this.orderField) {
      const field = this.orderField;
      list = [...list].sort((a, b) => compareValues(a as Record<string, unknown>, b as Record<string, unknown>, field));
    }
    if (this.reverseOrder) list = [...list].reverse();
    if (this.limitCount !== null) list = list.slice(0, this.limitCount);
    return list;
  }

  filter(predicate: (row: T) => boolean): Collection<T> {
    const next = new Collection<T>(this.table, (row) => this.predicate(row) && predicate(row), this.orderField);
    next.reverseOrder = this.reverseOrder;
    next.limitCount = this.limitCount;
    return next;
  }

  reverse(): Collection<T> {
    const next = this.clone();
    next.reverseOrder = !this.reverseOrder;
    return next;
  }

  limit(count: number): Collection<T> {
    const next = this.clone();
    next.limitCount = Math.max(0, Math.trunc(count));
    return next;
  }

  async toArray(): Promise<T[]> {
    return this.rows();
  }

  async first(): Promise<T | undefined> {
    return this.rows()[0];
  }

  async count(): Promise<number> {
    return this.rows().length;
  }

  async sortBy(field: string): Promise<T[]> {
    return [...this.rows()].sort((a, b) =>
      compareValues(a as Record<string, unknown>, b as Record<string, unknown>, field)
    );
  }

  async delete(): Promise<number> {
    const rows = this.rows();
    for (const row of rows) this.table.deleteRow(row.id);
    if (rows.length > 0) bump();
    return rows.length;
  }

  async modify(changes: Partial<T>): Promise<number> {
    const rows = this.rows();
    for (const row of rows) this.table.setRow({ ...row, ...changes });
    if (rows.length > 0) bump();
    return rows.length;
  }
}

function compareValues(a: Record<string, unknown>, b: Record<string, unknown>, field: string): number {
  const left = a[field];
  const right = b[field];
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left ?? "").localeCompare(String(right ?? ""));
}

/**
 * One in-memory table.
 *
 * The method names mirror the persistence layer this replaced so the rest of the
 * app did not have to be rewritten around a different vocabulary; what changed is
 * that none of it touches a disk.
 */
class Table<T extends Identified> {
  private readonly rows = new Map<string, T>();

  constructor(readonly name: string) {}

  snapshot(): T[] {
    return [...this.rows.values()];
  }

  setRow(row: T): void {
    this.rows.set(row.id, row);
    bump();
  }

  deleteRow(id: string): boolean {
    return this.rows.delete(id);
  }

  async add(row: T): Promise<string> {
    if (this.rows.has(row.id)) {
      throw new Error(`A row with id ${row.id} already exists in this session cache.`);
    }
    this.setRow(row);
    return row.id;
  }

  async put(row: T): Promise<string> {
    this.setRow(row);
    return row.id;
  }

  async bulkPut(rows: T[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, row);
    if (rows.length > 0) bump();
  }

  async bulkAdd(rows: T[]): Promise<void> {
    for (const row of rows) {
      if (this.rows.has(row.id)) throw new Error(`A row with id ${row.id} already exists in this session cache.`);
    }
    for (const row of rows) this.rows.set(row.id, row);
    if (rows.length > 0) bump();
  }

  async get(id: string): Promise<T | undefined> {
    return this.rows.get(id);
  }

  async update(id: string, changes: Partial<T>): Promise<number> {
    const existing = this.rows.get(id);
    if (!existing) return 0;
    this.setRow({ ...existing, ...changes });
    return 1;
  }

  async delete(id: string): Promise<void> {
    if (this.rows.delete(id)) bump();
  }

  async bulkDelete(ids: string[]): Promise<void> {
    let changed = false;
    for (const id of ids) changed = this.rows.delete(id) || changed;
    if (changed) bump();
  }

  async clear(): Promise<void> {
    if (this.rows.size > 0) {
      this.rows.clear();
      bump();
    }
  }

  async toArray(): Promise<T[]> {
    return this.snapshot();
  }

  async count(): Promise<number> {
    return this.rows.size;
  }

  filter(predicate: (row: T) => boolean): Collection<T> {
    return new Collection<T>(this, predicate);
  }

  orderBy(field: string): Collection<T> {
    return new Collection<T>(this, () => true, field);
  }

  where(field: string): { equals: (value: unknown) => Collection<T> } {
    return {
      equals: (value: unknown) =>
        new Collection<T>(this, (row) => (row as Record<string, unknown>)[field] === value),
    };
  }
}

/** The signed-in tab's cache. Nothing in it is persisted. */
export const db = {
  chats: new Table<Chat>("chats"),
  messages: new Table<ChatMessage>("messages"),
  folders: new Table<ChatFolder>("folders"),
  trash: new Table<TrashEntry>("trash"),
  agentRuns: new Table<AgentRunRecord>("agentRuns"),
  /**
   * Runs the callback. There is nothing to roll back — the rows are one object's
   * memory and the callback is synchronous in practice — so this exists to keep
   * the call sites that grouped a chat and its messages together readable.
   */
  async transaction(_mode: string, ...args: unknown[]): Promise<void> {
    const callback = args[args.length - 1];
    if (typeof callback === "function") await (callback as () => Promise<unknown>)();
  },
};

/**
 * Re-runs a query when the cache changes.
 *
 * The signature matches the hook this replaced, including the initial value, so
 * both direct table reads and `where(...)` chains keep working. A query that
 * throws leaves the previous answer on screen rather than blanking it.
 */
export function useLiveQuery<T>(query: () => T | Promise<T>): T | undefined;
export function useLiveQuery<T>(
  query: () => T | Promise<T>,
  deps: unknown[],
  initial: T
): T;
export function useLiveQuery<T>(
  query: () => T | Promise<T>,
  deps: unknown[] = [],
  initial?: T
): T | undefined {
  const [value, setValue] = useState<T | undefined>(initial);
  const cacheVersion = useSyncExternalStore(subscribe, currentVersion, currentVersion);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(query)
      .then((result) => {
        if (!cancelled) setValue(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `cacheVersion` is the subscription; the caller's deps are what the query
    // reads, and both must trigger a re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, ...deps]);

  return value;
}

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Chat operations ──────────────────────────────────────────────────────────

export async function createChat(title = "New chat"): Promise<Chat> {
  const now = Date.now();
  const chat: Chat = { id: uid(), title, createdAt: now, updatedAt: now };
  await db.chats.add(chat);
  return chat;
}

export async function touchChat(chatId: string): Promise<void> {
  await db.chats.update(chatId, { updatedAt: Date.now() });
}

/** Derive a short chat title from the first user message. */
export async function maybeAutoTitle(chatId: string, firstUserText: string): Promise<void> {
  const chat = await db.chats.get(chatId);
  if (!chat || chat.title !== "New chat") return;
  const clean = firstUserText.replace(/\s+/g, " ").trim();
  if (!clean) return;
  const title = clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
  await db.chats.update(chatId, { title, updatedAt: Date.now() });
}

export async function deleteChat(chatId: string): Promise<void> {
  await db.transaction("rw", db.chats, db.messages, db.agentRuns, async () => {
    await db.messages.where("chatId").equals(chatId).delete();
    // A turn for a chat that no longer exists has nothing to write into.
    await db.agentRuns.where("chatId").equals(chatId).delete();
    await db.chats.delete(chatId);
  });
}

export async function clearAllData(): Promise<void> {
  await db.transaction("rw", db.chats, db.messages, db.folders, db.trash, db.agentRuns, async () => {
    await db.messages.clear();
    await db.chats.clear();
    await db.agentRuns.clear();
    // "Clear" means clear: the trash goes with the rest, or a wiped browser is
    // one restore away from being unwiped.
    await db.folders.clear();
    await db.trash.clear();
  });
}

// ── Message operations ───────────────────────────────────────────────────────

/**
 * A timestamp strictly after the previous message in the same chat.
 *
 * `Date.now()` has millisecond resolution, and the send path appends a user
 * message and its empty answer back to back, so the two can share a timestamp.
 * Editing or regenerating cuts the thread by time, and a shared timestamp makes
 * that cut ambiguous: the old answer can survive an edit that meant to replace
 * it, or the question can be deleted along with the answer being retried. One
 * extra millisecond removes the ambiguity for good.
 */
export function nextMessageTime(previous: number, now = Date.now()): number {
  return Math.max(now, previous + 1);
}

/** The last timestamp this tab handed to a chat, so a burst cannot regress. */
const lastMessageAt = new Map<string, number>();

export async function addMessage(msg: Omit<ChatMessage, "id" | "createdAt">): Promise<ChatMessage> {
  const createdAt = nextMessageTime(lastMessageAt.get(msg.chatId) ?? 0);
  lastMessageAt.set(msg.chatId, createdAt);
  const full: ChatMessage = { ...msg, id: uid(), createdAt, updatedAt: createdAt };
  await db.messages.add(full);
  await touchChat(full.chatId);
  return full;
}

export async function updateMessageContent(id: string, content: string): Promise<void> {
  await db.messages.update(id, { content, updatedAt: Date.now() });
}

export async function setMessageError(id: string, error: string): Promise<void> {
  await db.messages.update(id, { error, updatedAt: Date.now() });
}

export async function setMessageUsage(
  id: string,
  usage: { prompt: number; completion: number; total: number }
): Promise<void> {
  await db.messages.update(id, { usage, updatedAt: Date.now() });
}

// ── A turn that outlived its tab ─────────────────────────────────────────────

/** Records the loop's state after a step, so the next one can be resumed. */
export async function saveAgentRun(run: Omit<AgentRunRecord, "updatedAt">): Promise<void> {
  await db.agentRuns.put({ ...run, updatedAt: Date.now() });
}

export async function readAgentRun(id: string): Promise<AgentRunRecord | undefined> {
  return db.agentRuns.get(id);
}

export async function clearAgentRun(id: string): Promise<void> {
  await db.agentRuns.delete(id);
}

/**
 * The next turn worth picking up, for the repository that is attached now.
 *
 * Oldest first, so two turns waiting are resumed in the order they were asked
 * for. A run for another repository is skipped: the hour session is bound to one
 * repository, so the server would refuse it anyway.
 */
export async function nextResumableAgentRun(projectId: string): Promise<AgentRunRecord | undefined> {
  const runs = await db.agentRuns.toArray();
  return runs
    .filter((run) => run.projectId === projectId)
    .sort((a, b) => a.updatedAt - b.updatedAt)[0];
}

// ── Backup / restore ─────────────────────────────────────────────────────────

export interface BackupPayload {
  app: "openmi";
  version: 1;
  exportedAt: string;
  chats: Chat[];
  messages: ChatMessage[];
}

export async function exportBackup(): Promise<BackupPayload> {
  const [chats, messages] = await Promise.all([db.chats.toArray(), db.messages.toArray()]);
  return {
    app: "openmi",
    version: 1,
    exportedAt: new Date().toISOString(),
    chats,
    messages,
  };
}

/**
 * A restore is a union, not a replace: rows from the file are put back and
 * anything already loaded is kept, so importing a backup into a session with
 * newer conversations cannot delete them. The bound is about a hostile or
 * accidental huge file, not about overwriting.
 */
const MAX_IMPORT_CHATS = 2000;
const MAX_IMPORT_MESSAGES = 50000;

export async function importBackup(payload: BackupPayload): Promise<{ chats: number; messages: number }> {
  if (payload?.app !== "openmi" || !Array.isArray(payload.chats) || !Array.isArray(payload.messages)) {
    throw new Error("Invalid Openmi backup file");
  }
  if (payload.chats.length > MAX_IMPORT_CHATS || payload.messages.length > MAX_IMPORT_MESSAGES) {
    throw new Error("That backup is too large to restore");
  }
  await db.transaction("rw", db.chats, db.messages, async () => {
    await db.chats.bulkPut(payload.chats);
    await db.messages.bulkPut(payload.messages);
  });
  return { chats: payload.chats.length, messages: payload.messages.length };
}

// ── Folders ───────────────────────────────────────────────────────────────────
// Sidebar organisation only. A folder is a name and an id — no nesting, no
// ordering table — because the question it answers is "which conversations are
// about work", and anything more than one level deep stops answering that.

const FOLDER_NAME_MAX = 32;

export async function createFolder(name: string): Promise<ChatFolder | null> {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, FOLDER_NAME_MAX);
  if (!clean) return null;
  const existing = await db.folders
    .filter((folder) => folder.name.toLowerCase() === clean.toLowerCase())
    .first();
  if (existing) return existing;
  const folder: ChatFolder = { id: uid(), name: clean, createdAt: Date.now() };
  await db.folders.add(folder);
  return folder;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, FOLDER_NAME_MAX);
  if (!clean) return;
  await db.folders.update(id, { name: clean });
}

/**
 * Deletes a folder and files its chats back under nothing.
 *
 * The chats are kept. A folder is a label on conversations somebody wrote, and
 * deleting the label by accident must not be able to delete the writing — the
 * rows it held simply return to the main list.
 */
export async function deleteFolder(id: string): Promise<void> {
  await db.transaction("rw", db.folders, db.chats, async () => {
    await db.folders.delete(id);
    await db.chats.where("folder").equals(id).modify({ folder: undefined });
  });
}

export async function setChatFolder(chatId: string, folderId: string | undefined): Promise<void> {
  // Deliberately not `touchChat`: filing a conversation is not conversation
  // activity, and it must not jump to the top of the list for it.
  await db.chats.update(chatId, { folder: folderId });
}

// ── Full-text search ─────────────────────────────────────────────────────────
// Runs over what the session has loaded. There is no device copy to scan while
// signed out any more, which is the point; the loaded account history is
// whatever the server returned.

export interface MessageSearchHit {
  chatId: string;
  messageId: string;
  title: string;
  /** The match with a little text either side, ready to render. */
  snippet: string;
  createdAt: number;
}

const SNIPPET_RADIUS = 46;
const SEARCH_LIMIT = 30;

function snippetFor(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/**
 * Finds messages whose text contains the query, newest first.
 *
 * Answers the *displayed* variant, because a search that returns text you cannot
 * then find on screen is worse than no search at all.
 */
export async function searchMessages(query: string): Promise<MessageSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const [chats, matches] = await Promise.all([
    db.chats.toArray(),
    db.messages
      .orderBy("createdAt")
      .reverse()
      .filter((message) => displayedContent(message).toLowerCase().includes(needle))
      .limit(SEARCH_LIMIT)
      .toArray(),
  ]);
  const titles = new Map(chats.map((chat) => [chat.id, chat.title]));

  return matches.map((message) => ({
    chatId: message.chatId,
    messageId: message.id,
    title: titles.get(message.chatId) ?? "Chat",
    snippet: snippetFor(displayedContent(message), needle),
    createdAt: message.createdAt,
  }));
}

// ── Mode preference ──────────────────────────────────────────────────────────
// A preference is not history: it is one small string that makes the next visit
// feel like the same person, and it carries nothing anybody wrote. It stays on
// the device.

const MODE_KEY = "openmi:selected-mode";

export function loadSelectedMode(): ModeId {
  if (typeof window === "undefined") return DEFAULT_MODE_ID;
  try {
    let value = window.localStorage.getItem(MODE_KEY);
    // "dev" is the pre-rename id of Code mode, so an existing browser that
    // selected it before the rename keeps its choice.
    if (value === "dev") value = "code";
    if (value && OPENMI_MODES.some((mode) => mode.id === value)) return value as ModeId;
    return DEFAULT_MODE_ID;
  } catch {
    return DEFAULT_MODE_ID;
  }
}

export function saveSelectedMode(mode: ModeId): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // non-fatal: preference simply won't persist
  }
}
