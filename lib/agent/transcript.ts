// ── What comes back from the browser, cleaned before it is trusted ───────────
//
// The step endpoint is stateless: the client carries the conversation and the
// tool transcript and sends them back with each request. That is the right
// design for a deployment with no session store, and it means every string in
// this file has made a round trip through a client that could have edited it.
//
// So nothing here is cast. Roles are an allowlist, every string is capped, and
// an entry that fails a check is dropped rather than repaired — a half-valid
// conversation is worse than a shorter one.
//
// One field is carried verbatim, and it is not decoration: Gemini 3 returns a
// `thought_signature` on each tool call and requires it back on the next
// request. Rebuilding the assistant message without it is what produced a
// blanket HTTP 400 on the second step of every tool loop. It is allowlisted to
// `google.thought_signature` and length-capped, because it is signature-shaped
// data from the wire, not a place to smuggle arbitrary JSON through.

import type { AgentMessage, AgentToolCall } from "./model";

export interface RepoChatMessage {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 40_000;
const MAX_TRANSCRIPT_ENTRIES = 60;
const MAX_TRANSCRIPT_CHARS = 240_000;
const MAX_SIGNATURE_CHARS = 16_000;
const MAX_TOOL_CALLS = 4;

/**
 * The one provider-side field a transcript must keep.
 *
 * Gemini 3 attaches a thought signature to each function call and rejects the
 * follow-up request without it. Anything else under `extra_content` is dropped:
 * it is model-shaped data from a third party, and the only part with a known
 * meaning is this one.
 */
export function cleanThoughtSignature(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const google = (value as Record<string, unknown>).google;
  if (!google || typeof google !== "object" || Array.isArray(google)) return undefined;
  const signature = (google as Record<string, unknown>).thought_signature;
  if (typeof signature !== "string" || signature.length === 0) return undefined;
  return { google: { thought_signature: signature.slice(0, MAX_SIGNATURE_CHARS) } };
}

/**
 * Some providers reject an assistant turn that carries tool calls and a null
 * content part ("Expected string or list of content parts, got: null"), and
 * others reject an empty string just as firmly. The message needs *something*
 * in it; what it says is irrelevant, so it says what it is.
 */
export const TOOL_CALL_PLACEHOLDER = "[tool call]";

export function cleanHistory(raw: unknown): RepoChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: RepoChatMessage[] = [];
  let chars = 0;
  for (const entry of raw.slice(-MAX_HISTORY_MESSAGES)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.role !== "user" && value.role !== "assistant") continue;
    if (typeof value.content !== "string" || !value.content.trim()) continue;
    const content = value.content.slice(0, 12_000);
    chars += content.length;
    if (chars > MAX_HISTORY_CHARS) break;
    out.push({ role: value.role, content });
  }
  return out;
}

function cleanToolCalls(raw: unknown): AgentToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: AgentToolCall[] = [];
  for (const call of raw.slice(0, MAX_TOOL_CALLS)) {
    if (!call || typeof call !== "object") continue;
    const value = call as Record<string, unknown>;
    const fn = value.function as Record<string, unknown> | undefined;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    const signature = cleanThoughtSignature(value.extra_content);
    calls.push({
      id: typeof value.id === "string" ? value.id.slice(0, 200) : "",
      type: "function",
      function: {
        name: fn.name.slice(0, 40),
        arguments: typeof fn.arguments === "string" ? fn.arguments.slice(0, 8_000) : "{}",
      },
      ...(signature ? { extra_content: signature } : {}),
    });
  }
  return calls;
}

/**
 * Validates the echoed transcript.
 *
 * A tool call must carry a name and string arguments, a tool result must carry
 * the id of the call it answers, and an assistant message that asked for tools
 * is given non-empty content — which is a wire requirement, not a cosmetic one.
 */
export function cleanTranscript(raw: unknown): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentMessage[] = [];
  let chars = 0;
  for (const entry of raw.slice(-MAX_TRANSCRIPT_ENTRIES)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const role = value.role;
    if (role !== "assistant" && role !== "tool" && role !== "user") continue;
    const content = typeof value.content === "string" ? value.content.slice(0, 24_000) : null;
    chars += content?.length ?? 0;
    if (chars > MAX_TRANSCRIPT_CHARS) break;

    if (role === "tool") {
      if (typeof value.tool_call_id !== "string" || !value.tool_call_id) continue;
      out.push({
        role: "tool",
        tool_call_id: value.tool_call_id.slice(0, 200),
        name: typeof value.name === "string" ? value.name.slice(0, 40) : undefined,
        content: content ?? "",
      });
      continue;
    }

    if (role === "user") {
      if (!content || !content.trim()) continue;
      out.push({ role: "user", content });
      continue;
    }

    const toolCalls = cleanToolCalls(value.tool_calls);
    if (toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: content && content.trim() ? content : TOOL_CALL_PLACEHOLDER,
        tool_calls: toolCalls,
      });
      continue;
    }
    if (!content || !content.trim()) continue;
    out.push({ role: "assistant", content });
  }
  return out;
}

export const TRANSCRIPT_LIMITS = {
  historyMessages: MAX_HISTORY_MESSAGES,
  transcriptEntries: MAX_TRANSCRIPT_ENTRIES,
  toolCalls: MAX_TOOL_CALLS,
} as const;
