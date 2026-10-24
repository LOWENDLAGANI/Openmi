// ── A shared answer, validated before it is published ────────────────────────
//
// The share table is public through a view, so what goes into it is checked
// twice: here, before the insert, and in the table's constraints. The snapshot
// is deliberately small — a title and the text of one exchange — because a
// share link is a quotation, not a copy of the account.
//
// Nothing in this module touches the network or the database. The API route
// decides who may share; this decides what a share is allowed to contain, and
// the public page uses the same parser so it cannot render a shape the writer
// would have refused.

export const SHARE_MAX_MESSAGES = 40;
export const SHARE_MAX_CHARS = 200_000;
export const SHARE_TITLE_MAX = 120;
export const SHARE_TTL_DAYS = 30;

export interface ShareMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ShareSnapshot {
  title: string;
  messages: ShareMessage[];
}

export interface ShareSummary {
  id: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

/**
 * The snapshot to publish, or null when the request is not a share.
 *
 * Empty messages are dropped rather than rejected: a thread can contain an
 * empty streaming placeholder, and refusing the whole share because of one is
 * a worse answer than publishing the part that exists. A share with no
 * non-empty messages is refused, because there is nothing to publish.
 */
export function buildShareSnapshot(input: unknown): ShareSnapshot | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { title?: unknown; messages?: unknown };
  if (!Array.isArray(raw.messages)) return null;
  if (raw.messages.length === 0 || raw.messages.length > SHARE_MAX_MESSAGES) return null;

  const messages: ShareMessage[] = [];
  let characters = 0;
  for (const entry of raw.messages) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as { role?: unknown; content?: unknown };
    if (row.role !== "user" && row.role !== "assistant") return null;
    if (typeof row.content !== "string") return null;
    const content = row.content.trim();
    if (!content) continue;
    characters += content.length;
    if (characters > SHARE_MAX_CHARS) return null;
    messages.push({ role: row.role, content });
  }

  if (messages.length === 0) return null;

  const asked = messages.find((message) => message.role === "user")?.content ?? "";
  const suggested = typeof raw.title === "string" ? raw.title.trim() : "";
  const title = (suggested || asked.split("\n")[0] || "Shared answer").slice(0, SHARE_TITLE_MAX).trim();

  return { title: title || "Shared answer", messages };
}

/**
 * The messages a public page may render.
 *
 * The view is trusted for access control, not for shape: a row written by an
 * older writer or by hand still passes through the same checks as a new one.
 * Invalid rows are dropped; a page with nothing left says the link is empty
 * rather than throwing.
 */
export function parseSharedMessages(value: unknown): ShareMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ShareMessage[] = [];
  let characters = 0;
  for (const entry of value.slice(0, SHARE_MAX_MESSAGES)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { role?: unknown; content?: unknown };
    if (row.role !== "user" && row.role !== "assistant") continue;
    if (typeof row.content !== "string") continue;
    const content = row.content.trim();
    if (!content) continue;
    characters += content.length;
    if (characters > SHARE_MAX_CHARS) break;
    messages.push({ role: row.role, content });
  }
  return messages;
}

/** True for an id the table would accept. */
export function isShareId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{16,64}$/.test(value);
}

/** The public page path for a share. */
export function sharePath(id: string): string {
  return `/share/${id}`;
}

/** The absolute link to put on a clipboard. */
export function shareUrl(origin: string, id: string): string {
  return `${origin.replace(/\/+$/, "")}${sharePath(id)}`;
}

/** A refusal from the share API, as a sentence worth showing. */
export function shareErrorMessage(cause: unknown): string {
  const error = cause as { message?: unknown; code?: unknown } | null;
  if (error?.code === "PGRST205" || error?.code === "42P01" || error?.code === "PGRST204") {
    return "Sharing is not set up on this deployment yet. Apply the latest migrations.";
  }
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  return "The link could not be created. Try again.";
}
