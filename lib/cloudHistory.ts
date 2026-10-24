// Chat history, memories and the visitor registry, in Postgres.

import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "./db";
import { parseRemoteChat, planChatMerge } from "./chatSync";
import { localStorageOrNull, markDeleted, readDeletedIds, unmarkDeleted } from "./deletedChats";
import {
  markFolderDeleted,
  readDeletedFolderIds,
  unmarkFolderDeleted,
} from "./deletedFolders";
import { currentUser, getSupabase, supabaseConfigured } from "./supabase";
import { TRASH_RETENTION_MS, type TrashEntry } from "./trash";
import {
  clearTrashDecision,
  markTrashDecision as recordTrashDecision,
  readTrashDecisions,
  type TrashDecision,
} from "./trashDecisions";
import { firstSeen } from "./visitorName";
import type { Chat, ChatFolder, ChatMessage, Memory } from "./types";

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
  const user = await currentUser();
  if (!user) return null;
  return { client, uid: user.id };
}

function deletedChatIds(): Set<string> {
  return readDeletedIds(localStorageOrNull());
}

export function markChatDeleted(chatId: string): void {
  markDeleted(localStorageOrNull(), chatId);
}

/** Forgets a deletion, for a chat put back from the trash. */
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
    folder_id: chat.folder ?? null,
    created_at: iso(chat.createdAt),
    updated_at: iso(chat.updatedAt ?? chat.createdAt),
  };
}

/** The stored column shape of one message. */
function messageRow(owner: string, message: ChatMessage) {
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
    steps: message.steps ?? null,
    changeset_id: message.changesetId ?? null,
    truncated: Boolean(message.truncated),
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
      .select("id, title, pinned, folder_id, created_at, updated_at")
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
      folder: row.folder_id,
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

    // An active chat is not a trashed one. This clears a stale local trash
    // entry after a restore on another device; the pull of the trash itself
    // runs first and leaves the marker decisions to that pass.
    if (localChat) await db.trash.delete(chatId);

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

// ── Folders ──────────────────────────────────────────────────────────────────
// A folder is a name and an id. Syncing it is the difference between "Work"
// existing on the phone where it was made and "Work" existing on the computer
// too. Deletion is soft in the database, so one device cannot be talked out of a
// deletion by another device's stale copy.

function folderRow(owner: string, folder: ChatFolder) {
  return {
    id: folder.id,
    owner,
    name: folder.name,
    created_at: iso(folder.createdAt),
    updated_at: iso(folder.updatedAt ?? folder.createdAt),
  };
}

/** Pushes one folder to the account, for a create. */
export async function syncFolderUp(folder: ChatFolder): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    await client.from("folders").upsert(folderRow(uid, folder), { onConflict: "id" });
  } catch {
    // Offline: the next sign-in's push carries it.
  }
}

/**
 * Pushes one chat's folder, so filing a conversation follows the account.
 *
 * Only `folder_id` is written: filing is not conversation activity, so the
 * chat's `updated_at` stays where it was and the row does not jump to the top
 * of the list on another device. If the chat has never been uploaded the update
 * matches nothing and the next full push carries it with the row.
 */
export async function syncChatFolder(
  chatId: string,
  folderId: string | undefined
): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    await client
      .from("chats")
      .update({ folder_id: folderId ?? null })
      .eq("owner", uid)
      .eq("id", chatId);
  } catch {
    // Offline: the next full push carries the assignment with the chat.
  }
}

/**
 * Marks one folder removed for every device.
 *
 * `deleted_at` is a soft delete because a hard one is invisible to a device
 * that still holds the folder: it would look like a folder this device has never
 * seen and be uploaded again. The local tombstone is cleared once the write is
 * accepted; an active upsert elsewhere never sends `deleted_at`, so the removal
 * survives a stale write.
 */
export async function syncFolderDelete(folderId: string): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    const { error } = await client
      .from("folders")
      .update({ deleted_at: new Date().toISOString() })
      .eq("owner", uid)
      .eq("id", folderId)
      .select("id");
    if (!error) unmarkFolderDeleted(localStorageOrNull(), folderId);
  } catch {
    // The local delete stands and the tombstone keeps it from being re-added.
  }
}

/**
 * Pushes this device's folders and pending removals.
 *
 * Run *after* `loadFoldersFromAccount`, so a folder deleted on another device is
 * removed here before this device can offer to upload it again.
 */
export async function syncFoldersToAccount(): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  const store = localStorageOrNull();
  const deleted = readDeletedFolderIds(store);
  try {
    const folders = await db.folders.toArray();
    for (const folder of folders) {
      if (deleted.has(folder.id)) continue;
      await client.from("folders").upsert(folderRow(uid, folder), { onConflict: "id" });
    }
    for (const id of deleted) {
      const { error } = await client
        .from("folders")
        .update({ deleted_at: new Date().toISOString() })
        .eq("owner", uid)
        .eq("id", id)
        .select("id");
      if (!error) unmarkFolderDeleted(store, id);
    }
  } catch {
    // Offline, or the migration is not applied yet. The local sidebar stands.
  }
}

/**
 * Brings the account's folders here and applies its removals.
 *
 * A live folder is added when this browser has never seen it, and its name is
 * updated when the account's copy is newer. A removed folder is deleted locally
 * and its chats are returned to the main list, which is the same thing the local
 * delete does — only now it reaches every device.
 */
export async function loadFoldersFromAccount(): Promise<{ added: number; removed: number } | null> {
  const current = await session();
  if (!current) return null;
  const { client, uid } = current;

  try {
    const { data, error } = await client
      .from("folders")
      .select("id, name, created_at, updated_at, deleted_at")
      .eq("owner", uid);
    if (error) return null;

    const store = localStorageOrNull();
    const tombstones = readDeletedFolderIds(store);
    let added = 0;
    let removed = 0;

    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;

      if (typeof row.deleted_at === "string") {
        const local = await db.folders.get(id);
        if (local) {
          await db.transaction("rw", db.folders, db.chats, async () => {
            await db.folders.delete(id);
            await db.chats.where("folder").equals(id).modify({ folder: undefined });
          });
          removed += 1;
        }
        markFolderDeleted(store, id);
        continue;
      }

      const name = typeof row.name === "string" ? row.name.trim().slice(0, 32) : "";
      if (!name || tombstones.has(id)) continue;

      const local = await db.folders.get(id);
      if (!local) {
        await db.folders.add({
          id,
          name,
          createdAt: ms(row.created_at) || Date.now(),
          updatedAt: ms(row.updated_at) || undefined,
        });
        added += 1;
        continue;
      }

      const remoteUpdated = ms(row.updated_at);
      if (local.name !== name && remoteUpdated > (local.updatedAt ?? local.createdAt)) {
        await db.folders.update(id, { name, updatedAt: remoteUpdated });
      }
    }

    return { added, removed };
  } catch {
    return null;
  }
}

// ── Trash ────────────────────────────────────────────────────────────────────
// A deleted chat is parked in the account's `trash` row with its whole thread,
// so the trash looks the same on every device and any of them can put it back.
// The live chat and message rows are removed at the same moment; the trash row
// is the only copy until a restore moves it back.
//
// Restoration and permanent deletion both set `purged_at` rather than deleting
// the row. The row is the message to every other device that this chat is no
// longer in the trash — and whether it is live again is answered by whether an
// active `chats` row exists.

function trashRow(owner: string, entry: TrashEntry) {
  return {
    id: entry.id,
    owner,
    title: entry.title,
    pinned: Boolean(entry.pinned),
    folder_id: entry.folder ?? null,
    messages: entry.messages,
    created_at: iso(entry.createdAt),
    updated_at: iso(entry.updatedAt),
    deleted_at: iso(entry.deletedAt),
    purged_at: null,
  };
}

/** Parks one chat in the account's trash and removes its live rows. */
export async function syncTrashPut(entry: TrashEntry): Promise<void> {
  const current = await session();
  if (!current) return;
  const { client, uid } = current;
  try {
    const put = await client.from("trash").upsert(trashRow(uid, entry), { onConflict: "id" });
    // Only remove the live copy once the snapshot is safely stored: an
    // interrupted move must never leave neither version on the account.
    if (put.error) return;
    await client.from("chat_messages").delete().eq("owner", uid).eq("chat_id", entry.id);
    await client.from("chats").delete().eq("owner", uid).eq("id", entry.id);
  } catch {
    // The local trash entry stands; the next successful sync repairs the row.
  }
}

/**
 * Marks a trashed chat as restored or permanently deleted, for every device.
 *
 * The local decision is kept until the account accepts it, so a restore made
 * offline is not undone by the next pull handing the chat back.
 */
export async function syncTrashRemove(chatId: string): Promise<boolean> {
  const current = await session();
  if (!current) return false;
  const { client, uid } = current;
  const store = localStorageOrNull();
  try {
    const { error } = await client
      .from("trash")
      .update({ purged_at: new Date().toISOString(), messages: [] })
      .eq("owner", uid)
      .eq("id", chatId);
    if (error) return false;
    clearTrashDecision(store, chatId);
    return true;
  } catch {
    // The local decision stands and stays queued; another device may keep its
    // copy until the next sign-in flushes it.
    return false;
  }
}

/** Records a trash decision that is about to be delivered. */
export function markTrashDecision(chatId: string, decision: TrashDecision): void {
  recordTrashDecision(localStorageOrNull(), chatId, decision);
}

/**
 * Delivers trash decisions that were made while offline.
 *
 * Runs *before* the pull, because the pull is what would otherwise resurrect
 * them: a restored chat would be parked back in the trash, and a chat deleted
 * for ever would reappear in it. Restores are uploaded first so the closed
 * trash row cannot be read by another device as "deleted for ever".
 */
export async function flushTrashDecisions(): Promise<void> {
  const store = localStorageOrNull();
  const pending = readTrashDecisions(store);
  if (pending.size === 0) return;
  const current = await session();
  if (!current) return;

  // Every decision's chat is either live again (restore) or gone (purge); one
  // full push puts the restored ones in the account before any row is closed.
  // A restore whose upload did not land keeps its queued decision and its open
  // trash row: closing it would tell the other devices the chat is gone.
  const hasRestore = [...pending.values()].some((decision) => decision === "restore");
  const uploaded = hasRestore ? await syncCloudHistory().catch(() => null) : null;
  const restoredUploaded = !hasRestore || Boolean(uploaded?.synced);

  for (const [chatId, decision] of pending) {
    if (decision === "restore" && !restoredUploaded) continue;
    await syncTrashRemove(chatId);
  }
}

/**
 * Brings the account's trash here and applies its removals.
 *
 * It runs before the chat pull, because a chat in the account's trash must be
 * absent from the account's live list and its local live copy has to be cleared
 * before the live rows are read. The active-chat ids are fetched alongside so a
 * purged row can be told apart: purged with a live chat means "restored", and
 * purged with no live chat means "deleted forever" or "expired".
 */
export async function loadTrashFromAccount(): Promise<{ entries: number } | null> {
  const current = await session();
  if (!current) return null;
  const { client, uid } = current;
  const cutoff = Date.now() - TRASH_RETENTION_MS;

  try {
    // Retention is enforced against the account as well, so an expired chat
    // cannot be handed back by another browser that has not opened the app in
    // a month. A failure here is not fatal: the local purge still runs.
    await client
      .from("trash")
      .update({ purged_at: new Date().toISOString(), messages: [] })
      .eq("owner", uid)
      .is("purged_at", null)
      .lt("deleted_at", new Date(cutoff).toISOString());

    const [trashResult, chatResult] = await Promise.all([
      client
        .from("trash")
        .select("id, title, pinned, folder_id, messages, created_at, updated_at, deleted_at, purged_at")
        .eq("owner", uid),
      client.from("chats").select("id").eq("owner", uid),
    ]);
    if (trashResult.error || chatResult.error) return null;

    const activeIds = new Set<string>(
      ((chatResult.data ?? []) as Array<{ id?: string }>)
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string")
    );

    let entries = 0;
    for (const row of (trashResult.data ?? []) as Record<string, unknown>[]) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;

      if (typeof row.purged_at === "string") {
        await db.trash.delete(id);
        // An active chat means the purge was a restore; without one it was a
        // permanent delete (or the thirty-day expiry), so the tombstone stays.
        if (activeIds.has(id)) unmarkChatDeleted(id);
        else markChatDeleted(id);
        continue;
      }

      const deletedAt = ms(row.deleted_at);
      if (!deletedAt || deletedAt < cutoff) {
        await db.trash.delete(id);
        markChatDeleted(id);
        continue;
      }

      const rawMessages = Array.isArray(row.messages) ? row.messages : [];
      const messageMap = Object.fromEntries(
        rawMessages
          .filter(
            (message): message is Record<string, unknown> =>
              Boolean(message) && typeof message === "object" && typeof (message as { id?: unknown }).id === "string"
          )
          .map((message) => [String(message.id), message])
      );
      const parsed = parseRemoteChat({
        id,
        title: row.title,
        createdAt: ms(row.created_at),
        updatedAt: ms(row.updated_at),
        pinned: row.pinned === true,
        folder: row.folder_id,
        messages: messageMap,
      });
      if (!parsed) continue;

      const entry: TrashEntry = {
        ...parsed.chat,
        messages: parsed.messages,
        deletedAt,
      };

      // A chat parked on another device leaves this one's live list too. The
      // transaction keeps the thread from being visible in both places at once.
      await db.transaction("rw", db.chats, db.messages, db.trash, async () => {
        await db.messages.where("chatId").equals(id).delete();
        await db.chats.delete(id);
        await db.trash.put(entry);
      });
      markChatDeleted(id);
      entries += 1;
    }

    return { entries };
  } catch {
    return null;
  }
}

/**
 * Pushes every local trash entry after a pull.
 *
 * This is what carries a deletion made while offline: the pull has already
 * removed entries the account purged, so whatever remains here is either still
 * in the account's trash or was never delivered. Both are safe to upsert.
 */
export async function syncLocalTrash(): Promise<void> {
  const entries = await db.trash.toArray();
  if (entries.length === 0) return;
  const current = await session();
  if (!current) return;
  const { client, uid } = current;

  // A row closed on another device after this device's pull must not be
  // reopened by the copy here: "delete forever" has to stay deleted, even when
  // the two decisions race. The local entry is dropped rather than uploaded.
  let purged = new Set<string>();
  try {
    const { data } = await client.from("trash").select("id, purged_at").eq("owner", uid);
    purged = new Set(
      ((data ?? []) as Record<string, unknown>[])
        .filter((row) => typeof row.purged_at === "string")
        .map((row) => String(row.id ?? ""))
        .filter(Boolean)
    );
  } catch {
    // Offline: fall through and let the upserts fail; nothing is lost locally.
  }

  for (const entry of entries) {
    if (purged.has(entry.id)) {
      await db.trash.delete(entry.id);
      markChatDeleted(entry.id);
      continue;
    }
    await syncTrashPut(entry);
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

    // The sidebar is part of "everything": folders disappear and the trash is
    // emptied for every device. Folders are soft-deleted for the same reason as
    // a single delete — a stale device must not upload one back.
    const now = new Date().toISOString();
    await client.from("folders").update({ deleted_at: now }).eq("owner", uid);
    await client.from("trash").update({ purged_at: now, messages: [] }).eq("owner", uid);
    await client.from("chat_messages").delete().eq("owner", uid);
    await client.from("chats").delete().eq("owner", uid);
  } catch {
    // Nothing to do — the local wipe stands and a later sync repairs the account.
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
