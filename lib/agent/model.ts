// ── One model call, with tools ───────────────────────────────────────────────
//
// The chat route streams text because that is what a conversation wants. An
// agent step is different: the model may answer with a tool call instead of
// prose, and a partial tool call is useless. So this call is non-streaming and
// returns one complete decision — text, tool calls, or both.
//
// Provider selection reuses the same server-only chains as the chat route. The
// Code family is tried first because repository work wants the model tuned for
// code, and the Auto chain is the fallback when no Code key exists. A family is
// never silently crossed in the other direction: the chain that answered is
// reported, so the interface can name it.

import { getProviders, type ProviderConfig } from "@/lib/providers";
import type { ParsedToolCall } from "./tools";

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
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
  "**The repository agent has no model configured.** The person who runs this deployment needs to add a model key before the agent can read a repository.";

function providerChain(): ProviderConfig[] {
  const seen = new Set<string>();
  const chain: ProviderConfig[] = [];
  for (const provider of [...getProviders("code"), ...getProviders("auto")]) {
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

interface WireReply {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

function cleanCalls(raw: WireReply["choices"]): ParsedToolCall[] {
  const message = raw?.[0]?.message;
  if (!message || !Array.isArray(message.tool_calls)) return [];
  const calls: ParsedToolCall[] = [];
  for (const call of message.tool_calls.slice(0, 4)) {
    const name = call?.function?.name;
    if (typeof name !== "string" || !name) continue;
    calls.push({
      id: typeof call.id === "string" && call.id ? call.id : `call_${calls.length}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      argumentJson: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
    });
  }
  return calls;
}

/**
 * Asks the first reachable provider for one decision.
 *
 * Throws a user-readable Error when no provider could answer. The message never
 * contains a key, an endpoint or a raw provider body: this text is rendered in
 * the chat.
 */
export async function callAgentModel(
  messages: AgentMessage[],
  tools: unknown[],
  signal?: AbortSignal
): Promise<AgentModelReply> {
  const chain = providerChain();
  if (chain.length === 0) throw new Error(AGENT_MODEL_MISSING);

  const failures: string[] = [];
  for (const provider of chain) {
    let response: Response;
    try {
      response = await fetch(provider.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.key}`,
          "Content-Type": "application/json",
          ...provider.headers,
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          tools,
          tool_choice: "auto",
          stream: false,
          temperature: 0.2,
        }),
        signal,
      });
    } catch {
      if (signal?.aborted) throw new Error("The request was cancelled.");
      failures.push(`${provider.label} could not be reached`);
      continue;
    }

    if (!response.ok) {
      // 401/402/403 will not improve on another model in the same family, but
      // they may on another family, so the loop continues either way. The
      // detail stays server-side; only the status is carried into the message.
      failures.push(`${provider.label} returned HTTP ${response.status}`);
      // Drain the body so the connection can be reused.
      await response.text().catch(() => "");
      continue;
    }

    const payload = (await response.json().catch(() => null)) as WireReply | null;
    if (!payload) {
      failures.push(`${provider.label} returned an unreadable response`);
      continue;
    }
    const upstreamError = typeof payload.error === "string" ? payload.error : payload.error?.message;
    if (upstreamError) {
      failures.push(`${provider.label} refused the request`);
      continue;
    }

    const choice = payload.choices?.[0];
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    const toolCalls = cleanCalls(payload.choices);
    if (!content.trim() && toolCalls.length === 0) {
      failures.push(`${provider.label} returned nothing`);
      continue;
    }

    return {
      content,
      toolCalls,
      usage: {
        prompt: payload.usage?.prompt_tokens ?? 0,
        completion: payload.usage?.completion_tokens ?? 0,
      },
      label: provider.label,
    };
  }

  throw new Error(
    `The repository agent could not get an answer. ${failures.slice(0, 2).join("; ")}. Try again, or reconnect GitHub if the problem continues.`
  );
}
