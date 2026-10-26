import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clientForToken } from "./supabase";
import type { ChatJobResult } from "./chatJobs";
import type { ApiMessage, SearchMode, SearchSource } from "./types";
import type { ModeId } from "./models";

// ── The turn that outlives the tab ───────────────────────────────────────────
// Background mode cannot mean "keep the browser's stream open after it closes".
// It means the work has to happen somewhere that outlives the request that
// started it, so the answer is produced here, written into the account, and
// recorded on the job row for the next visit to pick up.
//
// The model call itself is not re-implemented. This calls the real `/api/chat`
// handler with the sender's own Authorization header, so the same provider
// routing, web search, hour-session match, daily allowance, Dew charge and
// administrator controls apply exactly as they do to a foreground message.
// A background turn is not a cheaper or more privileged kind of turn.
//
// The deployment has no service key, so every write below uses the caller's
// token and is judged by the same row-level policies as the page. This module
// cannot write into another account, and does not try to.

export interface ChatJobInput {
  id: string;
  chatId: string;
  chatTitle: string;
  chatCreatedAt: number;
  userMessageId: string;
  assistantMessageId: string;
  messages: ApiMessage[];
  mode: ModeId;
  searchMode: SearchMode;
  responseLength?: "short" | "balanced" | "detailed";
  reasoningEffort?: "low" | "medium" | "high";
}

interface ChatEvent {
  content?: string;
  error?: string;
  model?: string;
  truncated?: boolean;
  usage?: { prompt: number; completion: number; total: number };
  search?: { used: boolean; query?: string; sources?: SearchSource[] };
}

const MAX_RESULT_CHARS = 2_000_000;

/**
 * Runs one background turn, then records what happened.
 *
 * Never throws: the caller schedules this after the HTTP response has already
 * been sent, so a rejection would only be logged as an unhandled one. Every
 * exit writes a terminal status, because a job left on "processing" is a tick
 * that never resolves on the user's screen.
 */
export async function runChatJob(input: ChatJobInput, authorization: string | null, origin: string): Promise<void> {
  const token = bearer(authorization);
  const client = token ? clientForToken(token) : null;
  if (!client) {
    // Nothing to write with and nobody to bill against. The job cannot be
    // started honestly, so it is not started.
    return;
  }

  await updateJob(client, input.id, { status: "processing" });

  let content = "";
  let model: string | undefined;
  let searchQuery: string | undefined;
  let sources: SearchSource[] | undefined;
  let usage: ChatJobResult["usage"];
  let truncated = false;
  let failure: string | undefined;

  try {
    const { POST } = await import("@/app/api/chat/route");
    const request = new NextRequest(new URL("/api/chat", origin || "http://localhost"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({
        messages: input.messages,
        mode: input.mode,
        chatId: input.chatId,
        searchMode: input.searchMode,
        responseLength: input.responseLength,
        reasoningEffort: input.reasoningEffort,
      }),
    });

    const response = await POST(request);
    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok || !contentType.includes("text/event-stream")) {
      // A refusal (paused, rate limited, out of Dew, too large) arrives as a
      // JSON body. Its sentence is the one the user should read in the thread,
      // not a generic "background run failed".
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      failure = payload?.error || `The background run was refused (HTTP ${response.status}).`;
    } else if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const apply = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let event: ChatEvent;
        try {
          event = JSON.parse(data) as ChatEvent;
        } catch {
          return;
        }
        if (event.model) model = event.model;
        if (event.truncated) truncated = true;
        if (typeof event.content === "string" && event.content) {
          content += event.content;
          if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS);
        }
        if (event.usage) usage = event.usage;
        if (event.search) {
          searchQuery = event.search.query;
          sources = event.search.sources ?? sources;
        }
        if (event.error) failure = event.error;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) apply(line);
      }
      if (buffer.trim()) apply(buffer);
    } else {
      failure = "The model returned no response.";
    }

    if (!failure && !content.trim()) failure = "Openmi returned an empty response. Try again.";
  } catch (error) {
    failure = error instanceof Error ? error.message : "The background run failed.";
  }

  const result: ChatJobResult = {
    content,
    ...(model ? { model } : {}),
    ...(searchQuery ? { searchQuery } : {}),
    ...(sources && sources.length > 0 ? { sources } : {}),
    ...(usage ? { usage } : {}),
    ...(truncated ? { truncated: true } : {}),
  };

  // The answer goes into the chat first. The job carries a copy either way, but
  // the message row is what the thread reads, so it is attempted before the
  // receipt is marked done.
  try {
    const now = new Date().toISOString();
    await client.from("chat_messages").upsert(
      {
        id: input.assistantMessageId,
        chat_id: input.chatId,
        role: "assistant",
        content,
        model: model ?? null,
        search_query: searchQuery ?? null,
        sources: sources ?? null,
        usage: usage ?? null,
        error: failure ?? null,
        truncated,
        created_at: now,
        updated_at: now,
      },
      { onConflict: "id" }
    );
  } catch {
    // A failed message write does not lose the answer: the result on the job is
    // what the next visit reads, and it re-creates the message from there.
  }

  await updateJob(client, input.id, {
    status: failure ? "failed" : "done",
    error: failure ?? null,
    result,
  });
}

function bearer(authorization: string | null): string {
  return authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

async function updateJob(
  client: SupabaseClient,
  id: string,
  changes: Record<string, unknown>
): Promise<void> {
  try {
    await client
      .from("chat_jobs")
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq("id", id);
  } catch {
    // The job row is the receipt, not the answer. If it cannot be updated the
    // run has still happened; there is nothing useful left to do here.
  }
}
