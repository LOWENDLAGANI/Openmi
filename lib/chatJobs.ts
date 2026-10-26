// ── Background turns, as both sides see them ─────────────────────────────────
// A job is the server's receipt for a message sent in background mode. This
// module is shared by the route that creates and runs it and the page that
// reads it back, so the two agree on what a job is without either importing
// the other.
//
// Everything parsed here arrives over the network (or from a table the caller
// can write), so it is checked field by field rather than cast. A job is only
// used to set a tick, add the answer, or show the reason it failed — never to
// grant anything.

import type { SearchSource } from "./types";

export type ChatJobStatus = "queued" | "processing" | "done" | "failed";

/** What the worker produced. Kept with the job so it survives a chat upload. */
export interface ChatJobResult {
  content: string;
  model?: string;
  searchQuery?: string;
  sources?: SearchSource[];
  usage?: { prompt: number; completion: number; total: number };
  truncated?: boolean;
}

export interface ChatJob {
  id: string;
  chatId: string;
  userMessageId: string;
  assistantMessageId: string;
  status: ChatJobStatus;
  error?: string;
  result?: ChatJobResult;
  /** Epoch ms, so the page can order and age a job without a timezone. */
  createdAt: number;
  updatedAt: number;
}

/** The shape the page generates and the route accepts. */
export const CHAT_JOB_ID = /^[A-Za-z0-9_-]{8,64}$/;

const STATUSES = new Set<ChatJobStatus>(["queued", "processing", "done", "failed"]);

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseSources(value: unknown): SearchSource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources: SearchSource[] = [];
  for (const raw of value.slice(0, 12)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.url !== "string" || !/^https?:\/\//i.test(entry.url)) continue;
    sources.push({
      id: typeof entry.id === "string" && entry.id ? entry.id.slice(0, 200) : String(sources.length + 1),
      title: typeof entry.title === "string" ? entry.title.slice(0, 300) : entry.url,
      url: entry.url.slice(0, 2000),
      snippet: typeof entry.snippet === "string" ? entry.snippet.slice(0, 1000) : "",
    });
  }
  return sources.length > 0 ? sources : undefined;
}

function parseResult(value: unknown): ChatJobResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.content !== "string") return undefined;
  const usage =
    raw.usage && typeof raw.usage === "object"
      ? (() => {
          const entry = raw.usage as Record<string, unknown>;
          const prompt = typeof entry.prompt === "number" ? entry.prompt : 0;
          const completion = typeof entry.completion === "number" ? entry.completion : 0;
          const total = typeof entry.total === "number" ? entry.total : prompt + completion;
          return { prompt, completion, total };
        })()
      : undefined;
  const sources = parseSources(raw.sources);
  return {
    content: raw.content.slice(0, 2_000_000),
    ...(typeof raw.model === "string" ? { model: raw.model.slice(0, 120) } : {}),
    ...(typeof raw.searchQuery === "string" ? { searchQuery: raw.searchQuery.slice(0, 400) } : {}),
    ...(sources ? { sources } : {}),
    ...(usage ? { usage } : {}),
    ...(raw.truncated === true ? { truncated: true } : {}),
  };
}

/**
 * Reads one row of `chat_jobs` as returned by PostgREST.
 *
 * `null` means the row cannot be understood well enough to act on, which is
 * better than a half-read job putting a tick on the wrong message.
 */
export function parseChatJob(value: unknown): ChatJob | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !CHAT_JOB_ID.test(row.id)) return null;
  if (typeof row.chat_id !== "string" || !row.chat_id) return null;
  if (typeof row.user_message_id !== "string" || !row.user_message_id) return null;
  if (typeof row.assistant_message_id !== "string" || !row.assistant_message_id) return null;
  if (typeof row.status !== "string" || !STATUSES.has(row.status as ChatJobStatus)) return null;

  return {
    id: row.id,
    chatId: row.chat_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status as ChatJobStatus,
    ...(typeof row.error === "string" ? { error: row.error.slice(0, 2000) } : {}),
    ...(parseResult(row.result) ? { result: parseResult(row.result) } : {}),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at) || timestamp(row.created_at),
  };
}

/** True while the answer is still owed. */
export function isPendingJob(job: ChatJob): boolean {
  return job.status === "queued" || job.status === "processing";
}
