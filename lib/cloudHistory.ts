// ── Chat history, memories and the visitor registry, in Postgres ────────────
//
// This is Dexie's sync partner. It writes chat and message rows through the
// caller's own session, so Postgres row-level security decides what may be
// written — the same arrangement the access rules had, with tables instead
// of a tree.
//
// ── Two-way, and a union ────────────────────────────────────────────────────
// History used to be write-only, and that is why signing in on a second browser
// showed the chats you had just asked to follow you: the data was being written
// correctly all along and then deliberately never read back. Logging without
// reading is fine for an audit trail and useless for a product that promises
// "your chats follow you to any browser".
//
// Merging is a union, never a replace. Two browsers can each hold chats the
// other has never seen, and a replace would silently delete one of them. Where
// the same message exists on both sides the newer `updatedAt` wins, which is the
// honest answer for two devices editing one thread.
//
// A pull must never resurrect something this device deleted, so deletions are
// recorded locally and honoured on the way in. The bookkeeping lives in
// lib/deletedChats.ts so the restore path can undo it and both directions can be
// tested without a browser.

import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { parseRemoteChat, planChatMerge } from "./chatSync";
import { localStorageOrNull, markDeleted, readDeletedIds, unmarkDeleted } from "./deletedChats";
import { ensureUser, getSupabase, supabaseConfigured } from "./supabase";
import { firstSeen } from "./visitorName";
import type { Chat, ChatMessage, Memory } from "./types";

/** Timestamps are stored as `timestamptz` and spoken here as epoch ms. */
function iso(ms: number | null | undefined): string {
  const value = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : Date.now();
  return new Date(value).toISOString();
}

function ms(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** The signed-in client and its user, or null when there is neither. */
async function session(): Promise<{ client: SupabaseClient; uid: string } | null> {
  const client = getSupabase();
  if (!client) return null;
  const user = await ensureUser();
  if (!user) return null;
  return { client, uid: user.id };
}

function deletedChatIds(): Set<string> {
  return readDeletedIds(localStorageOrNull());
}

export function markChatDeleted(chatId: string): void {
  markDeleted(localStorageOrNull(), chatId);
}

/**
 * Forgets a deletion, for a chat put back from the trash.
 *
 * Without this the restored chat stays on the deleted list for ever: it is
 * visible in this browser, excluded from every upload, and missing on every
 * other device the person signs into. Restoring something must mean restoring it
 * everywhere it can be restored.
 */
export function unmarkChatDeleted(chatId: string): void {
  unmarkDeleted(localStorageOrNull(), chatId);
}

/** The stored column shape of one chat. */
function chatRow(owner: string, chat: Chat) {
  return {
    id: chat.id,
    owner,
    title: chat.title,
    pinned: Boolean(chat.pinned),
    created_at: iso(chat.createdAt),
    updated_at: iso(chat.updatedAt ?? chat.createdAt),
  };
}

/** The stored column shape of one message. */
function messageRow(owner: string, message: ChatMessage) {
  // Images and document contents stay in Dexie; only text history is logged.
  return {
    id: message.id,
    chat_id: message.chatId,
    owner,
    role: message.role,
    content: message.content,
    model: message.model ?? null,
    search_query: message.searchQuery ?? null,
    sources: message.sources ?? null,
    usage: message.usage ?? null,
    error: message.error ?? null,
    // These three make the answer whole on another device. Without them a pull
    // shows the text but loses the agent's reads, the review card for a change
    // the person can still commit, and the warning that an answer was cut off.
    steps: message.steps ?? null,
    changeset_id: message.changesetId ?? null,
    truncated: Boolean(message.truncated),
    // Earlier answers travel too, so the variant stepper means the same thing
    // on a phone as it did on the computer the retry happened on.
    variants: message.variants ?? null,
    variant_index: message.variantIndex ?? null,
    created_at: iso(message.createdAt),
    updated_at: iso(message.updatedAt ?? message.createdAt),
  };
}

/** The column shape of one message, in the shape `parseRemoteChat` reads. */
function messageFromRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role,
    content: row.content,
    model: row.model ?? undefined,
    searchQuery: row.search_query ?? undefined,
    sources: row.sources ?? undefined,
    usage: row.usage ?? undefined,
    error: row.error ?? undefined,
    steps: row.steps ?? undefined,
    changesetId: row.changeset_id ?? undefined,
    truncated: row.truncated === true,
    variants: row.variants ?? undefined,
    variantIndex: row.variant_index ?? undefined,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at) || undefined,
  };
}

/**
 * Logs the current local chats to the signed-in account.
 *
 * This is the push half of the two-way sync. The pull half is
 * `loadChatsFromAccount` below, which is what actually makes a phone's history
 * appear on a computer signed in with the same account — logging alone only ever
 * left the chats where they were written.
 *
 * Each chat is written as a whole: the chat row, then its messages, then any
 * message row for that chat the local copy no longer has. That is the same
 * replace semantics the Realtime Database `set()` had, and it is what makes a
 * deleted message stay deleted rather than being handed back by the next pull.
 */
export async function syncCloudHistory(): Promise<{ synced: boolean; reason?: string }> {
  const localChats = await db.chats.toArray();
  // A chat this device has deliberately deleted must not be re-uploaded, or the
  // next pull would hand it straight back.
  const deleted = deletedChatIds();
  const uploadable = localChats.filter((chat) => !deleted.has(chat.id));
  if (uploadable.length === 0) return { synced: true, reason: "no-local-history" };

  const current = await session();
  if (!current) return { synced: false, reason: "not-configured" };
  const { client, uid } = current;

  for (const chat of uploadable) {
    const messages = await db.messages.where("chatId").equals(chat.id).sortBy("createdAt");

    const chatResult = await client
      .from("chats")
      .upsert(chatRow(uid, chat), { onConflict: "id" });
    if (chatResult.error) return { synced: false, reason: chatResult.error.message };

    // The chat is written as a whole: what this browser holds for it replaces
    // what the account holds for it. That is the same replace semantics the
    // Realtime Database `set()` had, and it is what keeps a message deleted here
    // from being handed back by the next pull. Messages go in one statement, so
    // there is no window in which the chat exists with half its history.
    const cleared = await client
      .from("chat_messages")
      .delete()
      .eq("owner", uid)
      .eq("chat_id", chat.id);
    if (cleared.error) return { synced: false, reason: cleared.error.message };

    if (messages.length > 0) {
      const messageResult = await client
        .from("chat_messages")
        .insert(messages.map((message) => messageRow(uid, message)));
      if (messageResult.error) return { synced: false, reason: messageResult.error.message };
    }
  }
  return { synced: true };
}

/**
 * Brings the account's chats into this browser.
 *
 * A union rather than a replace: anything already here is kept, and only chats
 * and messages this device has never seen are added. Messages present on both
 * sides take the newer copy, but never lose the attachments this browser holds
 * — images and documents were never uploaded, so the local copy stays the only
 * one that has them.
 *
 * Returns null on any failure, including a deployment whose migrations have not
 * been applied, so the caller keeps what it has instead of emptying itself.
 */
export async function loadChatsFromAccount(): Promise<{ chats: number; messages: number } | null> {
  const current = await session();
  if (!current) return null;
  const { client, uid } = current;

  const [chatResult, messageResult] = await Promise.all([
    client
      .from("chats")
      .select("id, title, pinned, created_at, updated_at")
      .eq("owner", uid),
    client
      .from("chat_messages")
      .select(
        "id, chat_id, role, content, model, search_query, sources, usage, error, steps, changeset_id, truncated, variants, variant_index, created_at, updated_at"
      )
      .eq("owner", uid),
  ]);
  if (chatResult.error || messageResult.error) return null;

  const messagesByChat = new Map<string, Record<string, unknown>[]>();
  for (const row of (messageResult.data ?? []) as Record<string, unknown>[]) {
    const key = String(row.chat_id ?? "");
    if (!key) continue;
    const list = messagesByChat.get(key) ?? [];
    list.push(messageFromRow(row));
    messagesByChat.set(key, list);
  }

  const deleted = deletedChatIds();
  let chatsAdded = 0;
  let messagesAdded = 0;

  for (const row of (chatResult.data ?? []) as Record<string, unknown>[]) {
    const chatId = typeof row.id === "string" ? row.id : "";
    if (!chatId || deleted.has(chatId)) continue;

    // Rebuilt in the nested shape the parser understands, so one parser decides
    // what is valid regardless of which store the data came from.
    const parsed = parseRemoteChat({
      id: chatId,
      title: row.title,
      createdAt: ms(row.created_at),
      updatedAt: ms(row.updated_at),
      pinned: row.pinned === true,
      messages: Object.fromEntries(
        (messagesByChat.get(chatId) ?? []).map((message) => [String(message.id), message])
      ),
    });
    if (!parsed) continue;

    const localChat = await db.chats.get(parsed.chat.id);
    const localMessages = localChat
      ? await db.messages.where("chatId").equals(parsed.chat.id).sortBy("createdAt")
      : [];
    const merge = planChatMerge(parsed, localChat, localMessages);

    // A chat and its messages go in together: a chat whose messages failed to
    // write would open as an empty thread, which reads as data loss.
    await db.transaction("rw", db.chats, db.messages, async () => {
      if (merge.addChat) {
        await db.chats.add(merge.chat);
        chatsAdded += 1;
      } else if (merge.chatUpdate) {
        await db.chats.update(merge.chat.id, merge.chatUpdate);
      }
      if (merge.addMessages.length > 0) await db.messages.bulkAdd(merge.addMessages);
      messagesAdded += merge.addMessages.length;
      for (const update of merge.updateMessages) {
        await db.messages.update(update.id, update.changes);
      }
    });
  }

  return { chats: chatsAdded, messages: messagesAdded };
}

/** Removes one chat from the account, so deleting here deletes everywhere. */
export async function syncChatDelete(chatId: string): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    await client.from("chat_messages").delete().eq("owner", uid).eq("chat_id", chatId);
    await client.from("chats").delete().eq("owner", uid).eq("id", chatId);
  } catch {
    // The local delete stands; the remote copy is cleaned up on a later write.
  }
}

/**
 * Wipes the account's chat history when this device wipes its own.
 *
 * This is the one place a bulk delete happens remotely, and it is only reached
 * from the sidebar's "clear all data", which already destroys everything this
 * browser holds without asking the account's opinion. Leaving the copy behind
 * would make the next sign-in restore everything someone had just erased.
 */
export async function syncChatWipe(): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    const { data } = await client.from("chats").select("id").eq("owner", uid);
    const ids = ((data ?? []) as Array<{ id?: string }>)
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string");
    // Recorded before the delete, so an interrupted wipe still cannot bring the
    // chats back on the next pull.
    for (const id of ids) markChatDeleted(id);
    await client.from("chat_messages").delete().eq("owner", uid);
    await client.from("chats").delete().eq("owner", uid);
  } catch {
    // Nothing to do — see syncChatDelete.
  }
}

// ── Memories ────────────────────────────────────────────────────────────────
// Memories are readable back by their owner, and so is chat history above. They
// differ in what they carry: a handful of short sentences about the person who
// wrote them, rather than their conversations.
//
// Sync is last-write-wins per id, which is the honest model here. Memories are
// written rarely and one at a time, so concurrent edits of the same id are not a
// real case, and merging them would need more machinery than the situation
// earns.

/** Pushes one memory to the account, so it follows the user to another device. */
export async function syncMemoryUp(memory: Memory): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    await client.from("memories").upsert(
      {
        id: memory.id,
        owner: uid,
        text: memory.text,
        created_at: iso(memory.createdAt),
        updated_at: iso(memory.updatedAt),
      },
      { onConflict: "id" }
    );
  } catch {
    // Offline, or the policies are not applied yet. The local memory still
    // stands — this is a convenience, never the source of truth.
  }
}

export async function syncMemoryDelete(id: string): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    await client.from("memories").delete().eq("owner", uid).eq("id", id);
  } catch {
    // Nothing to do — see syncMemoryUp.
  }
}

/**
 * Adopts memories written on another browser.
 *
 * Returns null on any failure so the caller keeps whatever this device already
 * has rather than showing an empty memory list. Adding a memory is a union
 * rather than a replace: memories this browser has that the other does not are
 * kept, since nothing here says they were removed.
 */
export async function loadMemoriesFromAccount(): Promise<Memory[] | null> {
  const current = await session();
  if (!current) return null;
  const { client, uid } = current;
  try {
    const { data, error } = await client
      .from("memories")
      .select("id, text, created_at, updated_at")
      .eq("owner", uid);
    if (error) return null;
    return ((data ?? []) as Record<string, unknown>[])
      .map((row) => {
        if (typeof row.id !== "string" || typeof row.text !== "string") return null;
        return {
          id: row.id,
          text: row.text,
          createdAt: ms(row.created_at),
          updatedAt: ms(row.updated_at),
        } satisfies Memory;
      })
      .filter((entry): entry is Memory => entry !== null);
  } catch {
    return null;
  }
}

// ── The visitor registry ────────────────────────────────────────────────────

export interface VisitorProfile {
  name: string;
  firstSeen: number;
  lastSeen: number;
}

/**
 * Stores the display name a visitor chose, against their own account.
 *
 * Only the name and two timestamps are written — never message content, which
 * stays in `chats` and `chat_messages` where the owner policy applies.
 *
 * This must never read first. A visitor has no SELECT on the registry at all —
 * that is the whole asymmetry of this table — so the write goes through
 * `register_visitor()`, which scopes itself to the caller and is the only door.
 * `firstSeen` therefore comes from this browser instead of from the database.
 */
export async function syncVisitorProfile(name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return;
  const current = await session();
  if (!current) return;
  const { client } = current;

  await client.rpc("register_visitor", {
    p_name: trimmed,
    p_first_seen: new Date(firstSeen()).toISOString(),
  });
}

/**
 * Lists every visitor that has given Openmi a name.
 *
 * Names and timestamps only. This is the one place Openmi reads back the
 * registry, it is readable by the administrator alone, and it deliberately
 * excludes the logged chat text.
 */
export async function fetchVisitorRegistry(): Promise<Array<VisitorProfile & { uid: string }>> {
  const current = await session();
  if (!current) return [];
  const { client } = current;
  const { data, error } = await client
    .from("visitor_registry")
    .select("owner, name, first_seen, last_seen");
  if (error || !data) return [];
  return (data as Record<string, unknown>[])
    .map((row) => ({
      uid: String(row.owner ?? ""),
      name: typeof row.name === "string" ? row.name : "",
      firstSeen: ms(row.first_seen),
      lastSeen: ms(row.last_seen),
    }))
    .filter((entry) => entry.uid && entry.name && entry.lastSeen > 0)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/** True when this deployment can store anything at all. */
export const cloudConfigured = supabaseConfigured;
