import Dexie, { type Table } from "dexie";
import type { AgentStep, Chat, ChatFolder, ChatMessage } from "./types";
import type { TrashEntry } from "./trash";
import { displayedContent } from "./variants";

// ── Openmi — zero-login client-side persistence (IndexedDB via Dexie) ─────────
//
// Client-side only. Anything the server keeps private — the identity system
// prompt, provider keys, wire model ids — lives in a separate module so it is
// never compiled into the page bundle. See lib/systemPrompt.ts.

/**
 * A repository turn that was still running when the tab went away.
 *
 * Device-local on purpose. The transcript is working state for one turn, not
 * conversation history: it is large, it is only meaningful to the loop that
 * produced it, and syncing it would hand a half-finished turn to a second
 * device that cannot continue it under this account's hour.
 */
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
  updatedAt: number;
}

export class OpenmiDB extends Dexie {
  chats!: Table<Chat, string>;
  messages!: Table<ChatMessage, string>;
  folders!: Table<ChatFolder, string>;
  trash!: Table<TrashEntry, string>;
  agentRuns!: Table<AgentRunRecord, string>;

  constructor() {
    super("openmi-db");
    this.version(1).stores({
      chats: "id, updatedAt, pinned",
      messages: "id, chatId, createdAt",
    });
    // Added in a later version rather than inside version 1. Dexie upgrades
    // existing databases from whatever version they were left at, so editing
    // the original declaration would not reach a browser that already has one.
    this.version(2).stores({
      chats: "id, updatedAt, pinned",
      messages: "id, chatId, createdAt",
      memories: "id, createdAt",
    });
    // Folders, and the index that lets the sidebar ask "everything in this
    // folder" of Dexie rather than of JavaScript. Declared as a new version
    // for the same reason as version 2: an existing browser has to be upgraded,
    // not re-declared.
    this.version(3).stores({
      chats: "id, updatedAt, pinned, folder",
      messages: "id, chatId, createdAt",
      memories: "id, createdAt",
      folders: "id, name",
    });
    // Scheduled messages and the trash. Both are device-local by design: a
    // scheduled send fires from this browser's own open tab, and a deleted
    // chat is recoverable here without the account ever holding a copy it
    // would then sync back.
    this.version(4).stores({
      chats: "id, updatedAt, pinned, folder",
      messages: "id, chatId, createdAt",
      memories: "id, createdAt",
      folders: "id, name",
      scheduled: "id, sendAt",
      trash: "id, deletedAt",
    });
    // The overhaul removed two device-local features — the memory list and
    // queued sends — so their tables are dropped. Omitting a store from a later
    // version is how Dexie deletes a table; leaving them declared would keep
    // dead data on every existing browser for ever.
    this.version(5).stores({
      chats: "id, updatedAt, pinned, folder",
      messages: "id, chatId, createdAt",
      folders: "id, name",
      trash: "id, deletedAt",
    });
    // A repository turn now outlives the tab that started it. The loop's wire
    // state — transcript, signed turn token, the text written so far — is kept
    // here after every step, so a reload can ask for the next one instead of
    // leaving a half-finished answer behind.
    this.version(6).stores({
      chats: "id, updatedAt, pinned, folder",
      messages: "id, chatId, createdAt",
      folders: "id, name",
      trash: "id, deletedAt",
      agentRuns: "id, chatId, updatedAt",
    });
  }
}

export const db = new OpenmiDB();

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

/** The last timestamp this browser handed to a chat, so a reload mid-burst
 *  cannot regress. Kept in memory only: persisted rows are always older than
 *  `Date.now()` by the time anything is appended again. */
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
 * for. A run for another repository is skipped rather than continued: the hour
 * session is bound to one repository, so the server would refuse it anyway.
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
 * anything this browser already holds is kept, so importing a backup into a
 * browser with newer conversations cannot delete them. The bound below is
 * therefore about a hostile or accidental huge file, not about overwriting.
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
 * row of chats it held simply returns to the main list.
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
 * IndexedDB has no full-text index, so this filters the whole message store —
 * which is fine precisely because the store is one person's own history on
 * their own device: tens of thousands of rows at the outside, scanned in
 * memory in a few milliseconds. The moment this ever became a server query it
 * would need an index, and it is deliberately not a server query: message text
 * never leaves the device to be searched.
 *
 * Answers the *displayed* variant, because a search that returns text you
 * cannot then find on screen is worse than no search at all.
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

// ── Mode preference (persisted outside Dexie to survive before DB open) ─────

import { DEFAULT_MODE_ID, OPENMI_MODES, type ModeId } from "./models";

const MODE_KEY = "openmi:selected-mode";

export function loadSelectedMode(): ModeId {
  if (typeof window === "undefined") return DEFAULT_MODE_ID;
  try {
    let v = window.localStorage.getItem(MODE_KEY);
    // "dev" is the pre-rename id of Code mode, so an existing browser that
    // selected it before the rename keeps its choice.
    if (v === "dev") v = "code";
    // Any mode currently in the catalog is a valid stored choice — including
    // Azure, Opus and Fable. An older build only recognised "auto" and "code",
    // which dropped every other selection on reload.
    if (v && OPENMI_MODES.some((m) => m.id === v)) return v as ModeId;
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
