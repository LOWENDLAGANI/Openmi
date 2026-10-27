// ── Reading the step stream ──────────────────────────────────────────────────
//
// `/api/agent/step` answers with one JSON object per line while it works, so the
// thread can say what is happening now instead of nothing until the step ends.
// This is the client half: a line reader that parses each event and hands it to
// the caller unchanged, and a validator that keeps a malformed line from writing
// nonsense into a message.
//
// Nothing here decides policy: it does not know how many steps a turn may take,
// what a charge is, or when the turn is over. Those live on the server and in
// the signed turn token. This module only turns bytes into events.

import type { AgentStep } from "./types";

export interface AgentProposalSummary {
  path: string;
  kind: "created" | "modified";
  added: number;
  removed: number;
}

/**
 * What the server reports about a change it pushed directly, when the person's
 * own message asked for that. Null on any other answer.
 *
 * Either a commit landed, or it did not and says why. The second case is not a
 * failure to hide: the change is still on the card, still reviewable, and the
 * thread has to say so rather than showing a push that never happened.
 */
export type DirectPushReport =
  | { sha: string; branch: string; warning: string | null }
  | { error: string; detail: string | null };

export type AgentStreamEvent =
  | { type: "thinking" }
  | { type: "delta"; text: string }
  | { type: "step"; index: number; step: AgentStep; pending: boolean }
  | {
      type: "done";
      content: string;
      steps: AgentStep[];
      transcript: unknown[];
      turnToken: string;
      done: boolean;
      exhausted: boolean;
      model: string;
      usage: { prompt: number; completion: number };
      proposals: AgentProposalSummary[];
      changesetId: string | null;
      changesetWarning: string | null;
      directPush: DirectPushReport | null;
    }
  | { type: "error"; error: string; status?: number; resetAt?: number | null };

const STEP_TOOLS = new Set<AgentStep["tool"]>(["list_files", "read_file", "search_code", "propose_edits"]);

function cleanStep(raw: unknown): AgentStep | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.label !== "string" || !value.label) return null;
  if (typeof value.tool !== "string" || !STEP_TOOLS.has(value.tool as AgentStep["tool"])) return null;
  return {
    tool: value.tool as AgentStep["tool"],
    label: value.label.slice(0, 400),
    ok: value.ok === true,
    ...(value.running === true ? { running: true } : {}),
  };
}

function cleanSteps(raw: unknown): AgentStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(cleanStep).filter((step): step is AgentStep => step !== null);
}

/**
 * Reads the direct-push report from a done line.
 *
 * Validated like everything else here: a report that is neither a commit nor a
 * reason is null, which reads as "no push happened", and the thread stays quiet
 * rather than saying something untrue about someone's repository.
 */
function cleanDirectPush(raw: unknown): DirectPushReport | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.error === "string" && value.error) {
    return { error: value.error, detail: typeof value.detail === "string" ? value.detail : null };
  }
  if (typeof value.sha === "string" && value.sha && typeof value.branch === "string" && value.branch) {
    return {
      sha: value.sha,
      branch: value.branch,
      warning: typeof value.warning === "string" ? value.warning : null,
    };
  }
  return null;
}

/**
 * Parses one line into an event, or null when the line is not one.
 *
 * A blank line is a keep-alive and is not an error. Anything else that does not
 * look like an event we know is dropped: a half-written line from a dropped
 * connection must not become a step in the timeline.
 */
export function parseAgentEvent(line: string): AgentStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  if (value.type === "thinking") return { type: "thinking" };

  if (value.type === "delta") {
    return typeof value.text === "string" && value.text ? { type: "delta", text: value.text } : null;
  }

  if (value.type === "step") {
    const step = cleanStep(value.step);
    if (!step) return null;
    return {
      type: "step",
      index: typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 ? value.index : 0,
      step,
      pending: value.pending === true,
    };
  }

  if (value.type === "error") {
    const error = typeof value.error === "string" && value.error ? value.error : "The repository agent failed.";
    return {
      type: "error",
      error,
      ...(typeof value.status === "number" ? { status: value.status } : {}),
      ...(typeof value.resetAt === "number" ? { resetAt: value.resetAt } : {}),
    };
  }

  if (value.type === "done") {
    const usage = (value.usage ?? {}) as Record<string, unknown>;
    return {
      type: "done",
      content: typeof value.content === "string" ? value.content : "",
      steps: cleanSteps(value.steps),
      transcript: Array.isArray(value.transcript) ? value.transcript : [],
      turnToken: typeof value.turnToken === "string" ? value.turnToken : "",
      done: value.done === true,
      exhausted: value.exhausted === true,
      model: typeof value.model === "string" ? value.model : "",
      usage: {
        prompt: typeof usage.prompt === "number" ? usage.prompt : 0,
        completion: typeof usage.completion === "number" ? usage.completion : 0,
      },
      proposals: Array.isArray(value.proposals) ? (value.proposals as AgentProposalSummary[]) : [],
      changesetId: typeof value.changesetId === "string" ? value.changesetId : null,
      changesetWarning: typeof value.changesetWarning === "string" ? value.changesetWarning : null,
      directPush: cleanDirectPush(value.directPush),
    };
  }

  return null;
}

/**
 * Reads the whole stream, calling `onEvent` for every event in order.
 *
 * Resolves when the server closes the stream. A stream that ends without a
 * `done` or an `error` was cut off: the caller sees no event and decides what to
 * say, because only it knows whether text already arrived.
 */
export async function readAgentStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentStreamEvent) => void
): Promise<{ sawDone: boolean; sawError: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let sawError = false;

  const flush = (line: string) => {
    const event = parseAgentEvent(line);
    if (!event) return;
    if (event.type === "done") sawDone = true;
    if (event.type === "error") sawError = true;
    onEvent(event);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        flush(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) flush(buffer);
  } finally {
    reader.releaseLock();
  }

  return { sawDone, sawError };
}
