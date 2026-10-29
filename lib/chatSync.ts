// ── How two devices' chat histories are reconciled ───────────────────────────
// Pure logic only. Nothing here touches the network or IndexedDB, so the rules
// that decide what a sync keeps, drops, and overwrites can be tested without a
// browser or a network.
//
// The whole point of this file is that a sync is a **union**. Openmi writes chat
// history to the account so it follows the person to another browser, and it
// was failing at exactly that: the data was written correctly and then never
// read back. Fixing that by replacing local history with remote history would
// have been worse than the bug — a phone and a computer each hold conversations
// the other has never seen, and last-one-wins would delete one of them on every
// visit. So every merge here adds what is missing and overwrites only what is
// demonstrably newer.

import type { AgentStep, Chat, ChatMessage } from "./types";

// ── Whose history this browser is holding ────────────────────────────────────
//
// IndexedDB is not scoped by an account: every chat this browser has ever held
// sits in one database, and the sidebar reads it without asking who is signed
// in. So when a second person signed in on the same device they found the first
// person's conversations in the list — and the push then wrote those rows into
// the second account. Nothing about that was ambiguous: the local copy belongs
// to exactly one account, and it has to say which.
//
// The rule below is the whole decision, kept pure so it can be tested without a
// browser. "Unknown owner" is treated as foreign on purpose: a cache written
// before this rule existed cannot be proved to belong to whoever is signing in,
// and the account's own copy is the one that survives the handover.

/** What to do when this browser's stored history meets the account signed in. */
export type DeviceHandover =
  /** The cache is this account's. Nothing is thrown away. */
  | "keep"
  /** No cache and no remembered owner: adopt the account; nothing to clear. */
  | "claim"
  /** The cache belongs to somebody else, or predates this rule: clear it. */
  | "switch";

export function planHandover(input: {
  /** The account id this browser last wrote down, if any. */
  storedOwner: string | null;
  /** The account that is signed in now. */
  uid: string;
  /** Whether any chat, message, folder or trash row is still stored here. */
  hasLocalHistory: boolean;
}): DeviceHandover {
  const { storedOwner, uid, hasLocalHistory } = input;
  if (storedOwner === uid) return "keep";
  if (!storedOwner && !hasLocalHistory) return "claim";
  return "switch";
}

/** The tools a stored step may name. Anything else is not one of ours. */
const STEP_TOOLS = new Set<AgentStep["tool"]>(["list_files", "read_file", "search_code", "read_issue", "propose_edits"]);
/** A change-set id, as lib/changesets.ts mints it — checked without importing
 *  that server module into a client bundle. */
const CHANGESET_ID = /^[0-9a-f]{20}$/;

/**
 * Parses the agent's step timeline from a remote message.
 *
 * Another device wrote this and the network carried it here, so it is checked
 * field by field: a label is rendered as text, and a tool name the interface
 * cannot interpret would render a blank row that claims nothing.
 */
function parseSteps(value: unknown): AgentStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: AgentStep[] = [];
  for (const raw of value.slice(0, 80)) {
    if (!raw || typeof raw !== "object") continue;
    const step = raw as Record<string, unknown>;
    if (typeof step.label !== "string" || !step.label) continue;
    if (typeof step.tool !== "string" || !STEP_TOOLS.has(step.tool as AgentStep["tool"])) continue;
    steps.push({ tool: step.tool as AgentStep["tool"], label: step.label.slice(0, 400), ok: step.ok === true });
  }
  return steps.length > 0 ? steps : undefined;
}

/** Earlier answers, checked as strings and capped like the app writes them. */
function parseVariants(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const variants = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, 8);
  return variants.length > 0 ? variants : undefined;
}

/** A chat as it comes back from the account, parsed and validated. */
export interface RemoteChat {
  chat: Chat;
  messages: ChatMessage[];
}

/**
 * Parses one node of `users/$uid/chats` into a chat and its messages.
 *
 * Everything read off the network is untrusted, so every field is checked
 * rather than cast. A node missing its id, or a message with a role the
 * interface cannot render, is dropped instead of being written into the local
 * database — a malformed entry must not be able to break the chat list.
 */
export function parseRemoteChat(value: unknown): RemoteChat | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as {
    id?: unknown;
    title?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    pinned?: unknown;
    folder?: unknown;
    messages?: unknown;
  };
  if (typeof entry.id !== "string" || !entry.id) return null;

  const chat: Chat = {
    id: entry.id,
    title: typeof entry.title === "string" ? entry.title : "New chat",
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
    pinned: Boolean(entry.pinned),
    folder: typeof entry.folder === "string" && entry.folder ? entry.folder : undefined,
  };

  const messages: ChatMessage[] = [];
  if (entry.messages && typeof entry.messages === "object") {
    for (const raw of Object.values(entry.messages as Record<string, unknown>)) {
      const message = raw as Partial<ChatMessage> | null;
      if (!message || typeof message.id !== "string") continue;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const variants = parseVariants(message.variants);
      const variantIndex =
        typeof message.variantIndex === "number" &&
        Number.isInteger(message.variantIndex) &&
        message.variantIndex >= 1 &&
        variants &&
        message.variantIndex <= variants.length
          ? message.variantIndex
          : undefined;

      messages.push({
        id: message.id,
        chatId: chat.id,
        role: message.role,
        content: typeof message.content === "string" ? message.content : "",
        model: typeof message.model === "string" ? message.model : undefined,
        searchQuery: typeof message.searchQuery === "string" ? message.searchQuery : undefined,
        sources: Array.isArray(message.sources) ? message.sources : undefined,
        usage: message.usage,
        error: typeof message.error === "string" ? message.error : undefined,
        // "Whether an answer was cut off" and "which reads produced it" are
        // part of the answer, not decoration: dropping them on the way to
        // another device shows an unfinished answer as a finished one and a
        // proposal with no way to review it.
        steps: parseSteps(message.steps),
        changesetId:
          typeof message.changesetId === "string" && CHANGESET_ID.test(message.changesetId)
            ? message.changesetId
            : undefined,
        truncated: message.truncated === true ? true : undefined,
        variants,
        variantIndex,
        createdAt: typeof message.createdAt === "number" ? message.createdAt : 0,
        updatedAt: typeof message.updatedAt === "number" ? message.updatedAt : undefined,
      });
    }
  }

  return { chat, messages };
}

function timeOf(record: { createdAt: number; updatedAt?: number }): number {
  return record.updatedAt ?? record.createdAt;
}

/**
 * Decides what to do with one remote chat.
 *
 * Returns null when the remote copy has nothing to add, which is the common
 * case: most chats on an account are already here, untouched, after a sync that
 * wrote them up from this same browser.
 */
export interface ChatMerge {
  chat: Chat;
  /** Set when the chat itself needs creating. */
  addChat: boolean;
  /** Set when the remote chat is newer and its title or pin should be adopted. */
  chatUpdate: Partial<Chat> | null;
  /** Messages this browser has never seen. */
  addMessages: ChatMessage[];
  /** Messages present on both sides where the remote copy is newer. */
  updateMessages: Array<{ id: string; changes: Partial<ChatMessage> }>;
}

export function planChatMerge(remote: RemoteChat, localChat: Chat | undefined, localMessages: ChatMessage[]): ChatMerge {
  const localById = new Map(localMessages.map((message) => [message.id, message]));

  const addMessages: ChatMessage[] = [];
  const updateMessages: Array<{ id: string; changes: Partial<ChatMessage> }> = [];

  for (const message of remote.messages) {
    const local = localById.get(message.id);
    if (!local) {
      addMessages.push(message);
      continue;
    }
    if (timeOf(message) <= timeOf(local)) continue;

    // Only the fields that are ever synced are listed. Images, documents and
    // generated images were never uploaded, so the local copy is the only one
    // that has them and it keeps them by not being overwritten here.
    updateMessages.push({
      id: message.id,
      changes: {
        content: message.content,
        model: message.model,
        searchQuery: message.searchQuery,
        sources: message.sources,
        usage: message.usage,
        error: message.error,
        // Only fields the remote copy actually carries. Writing `undefined`
        // here deletes the local value, and a message uploaded by a client
        // that predates these fields must not erase the review card or the
        // truncation warning this browser already has.
        ...(message.steps ? { steps: message.steps } : {}),
        ...(message.changesetId ? { changesetId: message.changesetId } : {}),
        ...(message.truncated ? { truncated: true } : {}),
        ...(message.variants ? { variants: message.variants } : {}),
        ...(message.variantIndex !== undefined ? { variantIndex: message.variantIndex } : {}),
        updatedAt: timeOf(message),
      },
    });
  }

  if (!localChat) {
    return { chat: remote.chat, addChat: true, chatUpdate: null, addMessages, updateMessages };
  }

  const newer = remote.chat.updatedAt > (localChat.updatedAt ?? 0);
  // Filing a chat into a folder deliberately does not touch `updatedAt` — it is
  // organisation, not activity — so a folder change has to be carried on its own
  // rather than waiting for the chat to be touched.
  const folderChanged = (remote.chat.folder ?? undefined) !== (localChat.folder ?? undefined);
  const chatUpdate =
    newer || folderChanged
      ? {
          ...(newer
            ? {
                title: remote.chat.title,
                updatedAt: remote.chat.updatedAt,
                // A pin made on either device is a pin. Unpinning is the one
                // change that needs the newer side to win, and the timestamp is
                // what decides.
                pinned: remote.chat.pinned,
              }
            : {}),
          ...(folderChanged ? { folder: remote.chat.folder } : {}),
        }
      : null;

  return { chat: localChat, addChat: false, chatUpdate, addMessages, updateMessages };
}