import { after, NextRequest } from "next/server";
import { clientForToken } from "@/lib/supabase";
import { verifyCaller, checkRateLimit, isSameOriginRequest, readConfig } from "@/lib/serverControl";
import { rateLimitMessage } from "@/lib/rateLimitPolicy";
import { CHAT_JOB_ID, parseChatJob, type ChatJobStatus } from "@/lib/chatJobs";
import { runChatJob } from "@/lib/serverChatJob";
import type { ApiMessage, SearchMode } from "@/lib/types";
import type { ModeId } from "@/lib/models";

// ── Background turns ─────────────────────────────────────────────────────────
// `POST` accepts a message that must keep running after the tab closes, writes
// the question into the account, and schedules the real chat turn with Next's
// `after()`. `GET` hands the page the receipts it polls: a tick for the
// question, then the answer the worker wrote.
//
// Nothing here trusts the client for anything that costs money. The model call
// is the ordinary `/api/chat` handler, with the sender's own token, so the Dew
// charge, the hour session, the daily allowance and every administrator control
// are decided there, exactly as they are for a message typed into an open tab.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The outer invocation has to outlive the model turn it starts; the chat
// handler's own ceiling is 120s and this wraps it. The host still caps this at
// whatever the deployment plan allows.
export const maxDuration = 300;

const MAX_MESSAGES = 120;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 200_000;
const MAX_ACTIVE_JOBS = 3;
/** A job that has not reported for this long is treated as interrupted. */
const STALE_MS = 15 * 60_000;

interface JobBody {
  jobId?: unknown;
  chatId?: unknown;
  chatTitle?: unknown;
  chatCreatedAt?: unknown;
  userMessageId?: unknown;
  assistantMessageId?: unknown;
  messages?: unknown;
  mode?: unknown;
  searchMode?: unknown;
  responseLength?: unknown;
  reasoningEffort?: unknown;
}

function noStore(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

/**
 * The message text a job carries.
 *
 * Background mode is text-only on purpose: a base64 image, a document's
 * contents and the answer have to survive the tab, and the chat upload does not
 * carry attachments at all. Rather than run a turn whose question would come
 * back without the picture it was about, the route refuses parts outright.
 */
function textOf(message: ApiMessage): string | null {
  if (!message || typeof message !== "object") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  return typeof message.content === "string" ? message.content : null;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req.headers)) {
    return noStore({ error: "This request came from another site." }, 403);
  }

  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) {
    return noStore({ error: "Sign in to run a message in the background." }, 401);
  }
  const token = bearer(authorization);
  const client = clientForToken(token);
  if (!client) {
    return noStore({ error: "Accounts are not configured on this deployment." }, 503);
  }

  const config = await readConfig();
  if (config.maintenanceEnabled) {
    return noStore({ error: config.maintenanceMessage }, 503);
  }
  if (!config.chatEnabled) {
    return noStore({ error: "Openmi is paused right now. Please try again shortly." }, 503);
  }

  const limit = await checkRateLimit(req, identity, "background");
  if (!limit.allowed) {
    return noStore(
      { error: rateLimitMessage(limit.scope, limit.retryAfterSeconds), retryAfterSeconds: limit.retryAfterSeconds },
      429
    );
  }

  let body: JobBody;
  try {
    body = (await req.json()) as JobBody;
  } catch {
    return noStore({ error: "Invalid JSON body" }, 400);
  }

  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!CHAT_JOB_ID.test(jobId)) return noStore({ error: "Invalid job id" }, 400);

  const chatId = typeof body.chatId === "string" ? body.chatId.trim().slice(0, 200) : "";
  const userMessageId = typeof body.userMessageId === "string" ? body.userMessageId.trim().slice(0, 200) : "";
  const assistantMessageId =
    typeof body.assistantMessageId === "string" ? body.assistantMessageId.trim().slice(0, 200) : "";
  if (!chatId || !userMessageId || !assistantMessageId) {
    return noStore({ error: "A job needs a chat and both message ids." }, 400);
  }

  const mode: ModeId = body.mode === "code" ? "code" : body.mode === "flash" ? "flash" : "auto";
  const searchMode: SearchMode = body.searchMode === "always" || body.searchMode === "off" ? body.searchMode : "auto";
  const responseLength =
    body.responseLength === "short" || body.responseLength === "detailed" ? body.responseLength : "balanced";
  const reasoningEffort = body.reasoningEffort === "low" || body.reasoningEffort === "high" ? body.reasoningEffort : "medium";
  const chatTitle =
    typeof body.chatTitle === "string" && body.chatTitle.trim() ? body.chatTitle.trim().slice(0, 120) : "New chat";
  const chatCreatedAt =
    typeof body.chatCreatedAt === "number" && Number.isFinite(body.chatCreatedAt) ? body.chatCreatedAt : Date.now();

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return noStore({ error: "`messages` must be a non-empty array" }, 400);
  }
  if (body.messages.length > MAX_MESSAGES) {
    return noStore({ error: `A background run can carry at most ${MAX_MESSAGES} messages.` }, 413);
  }

  const messages: ApiMessage[] = [];
  let totalChars = 0;
  for (const raw of body.messages) {
    const message = raw as ApiMessage;
    const text = textOf(message);
    if (text === null) {
      return noStore({ error: "Background mode sends text only. Remove attachments and try again." }, 400);
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      return noStore({ error: "One message is too long for a background run." }, 413);
    }
    totalChars += text.length;
    messages.push({ role: message.role, content: text });
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return noStore({ error: "This conversation is too long for a background run." }, 413);
  }

  const last = messages[messages.length - 1];
  const lastText = typeof last.content === "string" ? last.content : "";
  if (last.role !== "user" || !lastText.trim()) {
    return noStore({ error: "A background run has to end with the message being sent." }, 400);
  }

  // A retried POST (double click, a flaky network) must not buy a second turn.
  const existing = await client
    .from("chat_jobs")
    .select("id, chat_id, user_message_id, assistant_message_id, status, error, result, created_at, updated_at")
    .eq("owner", identity.uid)
    .eq("user_message_id", userMessageId)
    .maybeSingle();
  if (existing.data) {
    return noStore({ job: parseChatJob(existing.data) }, 202);
  }

  const active = await client
    .from("chat_jobs")
    .select("id", { count: "exact", head: true })
    .eq("owner", identity.uid)
    .in("status", ["queued", "processing"])
    .gte("created_at", new Date(Date.now() - STALE_MS).toISOString());
  if ((active.count ?? 0) >= MAX_ACTIVE_JOBS) {
    return noStore(
      { error: "You already have background answers running. Wait for one to finish and try again." },
      429
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // The chat row first, so a reload in another tab can find the conversation
  // before the answer exists. `ignoreDuplicates` keeps an older chat's real
  // title and creation time: this is a receipt, not a rename.
  const chatWrite = await client.from("chats").upsert(
    {
      id: chatId,
      title: chatTitle,
      created_at: new Date(chatCreatedAt).toISOString(),
      updated_at: nowIso,
    },
    { onConflict: "id", ignoreDuplicates: true }
  );
  if (chatWrite.error) {
    return noStore({ error: "The chat could not be saved for a background run." }, 503);
  }

  const messageWrite = await client.from("chat_messages").upsert(
    {
      id: userMessageId,
      chat_id: chatId,
      role: "user",
      content: lastText,
      created_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "id", ignoreDuplicates: true }
  );
  if (messageWrite.error) {
    return noStore({ error: "The message could not be saved for a background run." }, 503);
  }

  const jobWrite = await client.from("chat_jobs").insert({
    id: jobId,
    chat_id: chatId,
    user_message_id: userMessageId,
    assistant_message_id: assistantMessageId,
    status: "queued",
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (jobWrite.error) {
    // The one configuration failure worth naming: the migration was never
    // applied, so there is no receipt to hang the answer on.
    if (jobWrite.error.code === "42P01") {
      return noStore(
        { error: "Background messages need the latest database migration (chat_jobs) applied." },
        503
      );
    }
    return noStore({ error: jobWrite.error.message }, 503);
  }

  // Scheduled after this response, so the 202 reaches the browser before the
  // model call starts. `after()` runs even though the tab is already gone.
  after(() =>
    runChatJob(
      {
        id: jobId,
        chatId,
        chatTitle,
        chatCreatedAt,
        userMessageId,
        assistantMessageId,
        messages,
        mode,
        searchMode,
        responseLength,
        reasoningEffort,
      },
      authorization,
      req.nextUrl.origin
    )
  );

  return noStore(
    {
      job: {
        id: jobId,
        chatId,
        userMessageId,
        assistantMessageId,
        status: "queued" as ChatJobStatus,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      },
    },
    202
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  if (!identity) return noStore({ error: "Sign in to read background runs." }, 401);
  const client = clientForToken(bearer(authorization));
  if (!client) return noStore({ error: "Accounts are not configured on this deployment." }, 503);

  const limit = await checkRateLimit(req, identity, "background-read");
  if (!limit.allowed) {
    return noStore(
      { error: rateLimitMessage(limit.scope, limit.retryAfterSeconds), retryAfterSeconds: limit.retryAfterSeconds },
      429
    );
  }

  // The list is receipts only. The answer text is returned solely for one job
  // asked for by id, so a page that polls every few seconds is not re-reading
  // every answer it has already collected.
  const id = req.nextUrl.searchParams.get("id");
  const columns =
    "id, chat_id, user_message_id, assistant_message_id, status, error, created_at, updated_at" +
    (id ? ", result" : "");
  let query = client
    .from("chat_jobs")
    .select(columns)
    .eq("owner", identity.uid)
    .order("created_at", { ascending: false })
    .limit(id ? 1 : 50);
  if (id) query = query.eq("id", id.slice(0, 64));
  else query = query.gte("created_at", new Date(Date.now() - 24 * 60 * 60_000).toISOString());

  const { data, error } = await query;
  if (error) {
    if (error.code === "42P01") {
      return noStore({ error: "Background messages need the latest database migration (chat_jobs) applied." }, 503);
    }
    return noStore({ error: error.message }, 500);
  }

  // A worker that died leaves "processing" behind. A tick that never resolves
  // is worse than an honest failure, so a job with no update for fifteen
  // minutes is closed here, where the page will read it.
  const cutoff = Date.now() - STALE_MS;
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  for (const row of rows) {
    const status = row.status as ChatJobStatus;
    const updated = Date.parse(String(row.updated_at ?? row.created_at));
    if ((status === "queued" || status === "processing") && Number.isFinite(updated) && updated < cutoff) {
      const message = "The background run was interrupted before it finished.";
      await client
        .from("chat_jobs")
        .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
        .eq("owner", identity.uid)
        .eq("id", row.id);
      row.status = "failed";
      row.error = message;
      row.updated_at = new Date().toISOString();
    }
  }

  const jobs = rows.map(parseChatJob).filter(Boolean);
  return noStore(id ? { job: jobs[0] ?? null } : { jobs });
}
