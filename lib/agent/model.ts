// ── One model call, with tools ───────────────────────────────────────────────
//
// The chat route streams text because that is what a conversation wants. An
// agent step is different: the model may answer with a tool call instead of
// prose, and a partial tool call is useless. So the decision is only acted on
// once it is complete — but the text is streamed out as it arrives, because a
// person watching an agent think should see the words land rather than a frozen
// card that only changes when the whole turn ends.
//
// Provider selection reuses the same server-only chains as the chat route. The
// Code family is tried first because repository work wants the model tuned for
// code, and the Auto chain is the fallback when no Code key exists. A family is
// never silently crossed in the other direction: the chain that answered is
// reported, so the interface can name it.
//
// Two details here are the difference between a tool loop that works and one
// that fails on its second request:
//
//   - an assistant turn that carries tool calls is given non-empty content,
//     because a null content part is refused by the wire;
//   - `extra_content.google.thought_signature` on each tool call is kept and
//     sent back, because Gemini 3 requires it and treats a missing one as a
//     malformed request.
//
// Both were the cause of a blanket HTTP 400 on the step after the first tool
// call: every model in the chain refused the same reconstructed message.

import { getProviders, type ProviderConfig, type ProviderFamily } from "@/lib/providers";
import { cleanThoughtSignature } from "./transcript";
import type { ParsedToolCall } from "./tools";

export interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider-issued data that must survive the round trip, e.g. a signature. */
  extra_content?: Record<string, unknown>;
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentModelReply {
  content: string;
  toolCalls: ParsedToolCall[];
  usage: { prompt: number; completion: number };
  /** The product name of the model that answered, for the message header. */
  label: string;
}

/** Shown when the deployment has no key at all. */
export const AGENT_MODEL_MISSING =
  "**The repository agent has no model to run.** Add your own Groq key in Settings → API keys, or ask the person who runs this deployment to configure one.";

/** Everything the caller wants to show while the step is still running. */
export interface AgentStreamSink {
  /** One fragment of the model's prose, exactly as it arrived. */
  onDelta?(text: string): void;
}

function providerChain(
  accountKeys: Partial<Record<ProviderFamily, string>> = {}
): ProviderConfig[] {
  const seen = new Set<string>();
  const chain: ProviderConfig[] = [];
  for (const provider of [...getProviders("code", accountKeys), ...getProviders("auto", accountKeys)]) {
    const key = `${provider.family}:${provider.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(provider);
  }
  return chain;
}

/** True when at least one provider could answer. */
export function agentModelConfigured(): boolean {
  return providerChain().length > 0;
}

interface WireChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
        extra_content?: unknown;
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/**
 * The reason a provider gave, with anything identifying stripped.
 *
 * This text is rendered in the chat, where a provider name, endpoint or model
 * id has no business appearing. What is left is the part a reader can act on:
 * "invalid argument: contents.parts must not be empty".
 */
function readableDetail(raw: string): string {
  if (!raw) return "";
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    const message =
      typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? "";
    if (message) text = message;
  } catch {
    // Not JSON: a plain-text body is already the message.
  }
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/gemini-[\w.\-]+/g, "the configured model")
    .replace(/\bmodels\/\S+/g, "the configured model")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

/**
 * The transcript as this provider should receive it.
 *
 * The thought signature is Gemini's own field. It has to go back to Gemini and
 * it must not go anywhere else: another OpenAI-compatible API is entitled to
 * reject an assistant turn carrying a property it has never heard of, which
 * would turn a working fallback into a 400.
 */
function wireMessages(provider: ProviderConfig, messages: AgentMessage[]): AgentMessage[] {
  if (provider.family === "gemini") return messages;
  return messages.map((message) => {
    if (!message.tool_calls?.some((call) => call.extra_content)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: call.type,
        function: call.function,
      })),
    };
  });
}

/** A short, user-safe line for the failure list. */
function failureLine(provider: ProviderConfig, status: number, raw: string): string {
  const detail = readableDetail(raw);
  return `${provider.label} rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}`;
}

/**
 * Provider diagnostics, server-side only.
 *
 * The status alone was not enough to debug a 400 that every model returned: the
 * body says which field the provider objected to. It is logged, truncated, and
 * never returned to the browser — the route's error text carries the sanitised
 * sentence instead.
 */
function logFailure(provider: ProviderConfig, status: number, raw: string): void {
  const detail = raw.replace(/\s+/g, " ").trim().slice(0, 500);
  console.warn(`[agent] ${provider.label} returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
}

/** Rough token count for providers that do not report usage on a stream. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

interface CallAccumulator {
  id: string;
  name: string;
  arguments: string;
  extraContent?: Record<string, unknown>;
}

/**
 * Asks one provider for one decision, streaming its prose as it arrives.
 *
 * Returns null when this provider could not answer and another one should be
 * tried. A provider that fails after it has already streamed text is *not*
 * retried: replaying a second model over the top of the first one's words is
 * worse than an answer that stops early, so what arrived is kept.
 */
async function streamFrom(
  provider: ProviderConfig,
  messages: AgentMessage[],
  tools: unknown[],
  signal: AbortSignal | undefined,
  sink: AgentStreamSink | undefined,
  failures: string[]
): Promise<AgentModelReply | null> {
  let response: Response;
  try {
    response = await fetch(provider.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.key}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        ...provider.headers,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: wireMessages(provider, messages),
        tools,
        tool_choice: "auto",
        stream: true,
        temperature: 0.2,
      }),
      signal,
    });
  } catch {
    if (signal?.aborted) throw new Error("The request was cancelled.");
    failures.push(`${provider.label} could not be reached`);
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    logFailure(provider, response.status, detail);
    failures.push(failureLine(provider, response.status, detail));
    return null;
  }
  if (!response.body) {
    failures.push(`${provider.label} returned an empty stream`);
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  // Held in an object because the stream callback is what writes it: a plain
  // `let` would be read as its initial `null` after the loop.
  const reported = { usage: null as { prompt: number; completion: number } | null };
  let upstreamError: string | null = null;
  const calls = new Map<number, CallAccumulator>();

  const slotFor = (index: number | undefined, id: string | undefined): CallAccumulator => {
    if (typeof index === "number" && Number.isFinite(index)) {
      const existing = calls.get(index);
      if (existing) {
        if (id && !existing.id) existing.id = id;
        return existing;
      }
      const created: CallAccumulator = { id: id ?? "", name: "", arguments: "" };
      calls.set(index, created);
      return created;
    }
    if (id) {
      for (const acc of calls.values()) if (acc.id === id) return acc;
      const created: CallAccumulator = { id, name: "", arguments: "" };
      calls.set(calls.size, created);
      return created;
    }
    // No index and no id: this provider sends one call in fragments, so a
    // fragment with no identity belongs to the call already open.
    const keys = [...calls.keys()];
    const last = keys.at(-1);
    if (last !== undefined) return calls.get(last)!;
    const created: CallAccumulator = { id: "", name: "", arguments: "" };
    calls.set(0, created);
    return created;
  };

  const consume = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let chunk: WireChunk;
    try {
      chunk = JSON.parse(data) as WireChunk;
    } catch {
      return; // A keep-alive or a comment line, not an event.
    }

    const upstream = typeof chunk.error === "string" ? chunk.error : chunk.error?.message;
    if (upstream) {
      upstreamError = upstream;
      return;
    }
    if (chunk.usage) {
      reported.usage = {
        prompt: chunk.usage.prompt_tokens ?? 0,
        completion: chunk.usage.completion_tokens ?? 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      sink?.onDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const acc = slotFor(call?.index, typeof call?.id === "string" && call.id ? call.id : undefined);
        if (typeof call?.id === "string" && call.id) acc.id = call.id;
        if (typeof call?.function?.name === "string" && call.function.name) acc.name = call.function.name;
        if (typeof call?.function?.arguments === "string") acc.arguments += call.function.arguments;
        const signature = cleanThoughtSignature(call?.extra_content);
        if (signature) acc.extraContent = signature;
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    if (buffer.trim()) consume(buffer);
  } catch {
    if (signal?.aborted) throw new Error("The request was cancelled.");
    // A stream that breaks after producing text keeps what it produced; one
    // that broke before producing anything is another provider's turn.
    if (!content.trim()) {
      failures.push(`${provider.label} stopped before answering`);
      return null;
    }
  }

  if (upstreamError) {
    logFailure(provider, 400, upstreamError);
    if (!content.trim()) {
      failures.push(failureLine(provider, 400, upstreamError));
      return null;
    }
  }

  const toolCalls: ParsedToolCall[] = [];
  for (const acc of calls.values()) {
    if (!acc.name) continue;
    toolCalls.push({
      id: acc.id || `call_${toolCalls.length}_${Math.random().toString(36).slice(2, 8)}`,
      name: acc.name,
      argumentJson: acc.arguments || "{}",
      ...(acc.extraContent ? { extraContent: acc.extraContent } : {}),
    });
  }

  if (!content.trim() && toolCalls.length === 0) {
    failures.push(`${provider.label} returned nothing`);
    return null;
  }

  const promptChars = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
  const completionChars = content.length + toolCalls.reduce((sum, call) => sum + call.argumentJson.length, 0);

  return {
    content,
    toolCalls,
    usage:
      reported.usage && (reported.usage.prompt > 0 || reported.usage.completion > 0)
        ? reported.usage
        : { prompt: estimateTokens(promptChars), completion: estimateTokens(completionChars) },
    label: provider.label,
  };
}

/**
 * Asks the first reachable provider for one decision.
 *
 * Throws a user-readable Error when no provider could answer. The message never
 * contains a key or an endpoint: it names the product model and, when the
 * provider gave a reason worth repeating, the sanitised reason.
 */
export async function callAgentModel(
  messages: AgentMessage[],
  tools: unknown[],
  signal?: AbortSignal,
  sink?: AgentStreamSink,
  /** The caller's own provider keys, preferred over the deployment's. */
  accountKeys: Partial<Record<ProviderFamily, string>> = {}
): Promise<AgentModelReply> {
  const chain = providerChain(accountKeys);
  if (chain.length === 0) throw new Error(AGENT_MODEL_MISSING);

  const failures: string[] = [];
  for (const provider of chain) {
    const reply = await streamFrom(provider, messages, tools, signal, sink, failures);
    if (reply) return reply;
  }

  throw new Error(
    `The repository agent could not get an answer. ${failures.slice(0, 3).join("; ")}. Try again, or reconnect GitHub if the problem continues.`
  );
}
