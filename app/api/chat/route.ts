import { NextRequest } from "next/server";
import { OPENMI_SYSTEM_PROMPT } from "@/lib/systemPrompt";
import type { ReasoningEffort } from "@/lib/settings";
import type { ApiMessage, SearchMode, SearchSource } from "@/lib/types";
import { getModelDisplayName, type ModeId } from "@/lib/models";
import { CONTEXT_BUDGET } from "@/lib/contextBudget";
import { toOpenmiName } from "@/lib/modelEngines";
import { FAMILY_MODE, getProviders, type ProviderConfig } from "@/lib/providers";
import { CODE_SYSTEM_PROMPT } from "@/lib/codePrompt";
import { formatSearchContext, searchWeb, shouldUseWebSearch } from "@/lib/webSearch";
import { modeCapabilities } from "@/lib/models";
import {
  checkRateLimit,
  identityGate,
  isAdmin,
  rateLimitHeaders,
  readConfig,
  verifyCaller,
} from "@/lib/serverControl";
import { rateLimitMessage } from "@/lib/rateLimitPolicy";
import { readUserKeys } from "@/lib/providerKeys";
import {
  hourModelRefusal,
  markHourSessionActivity,
  readHourSession,
  refundHourSession,
} from "@/lib/hourSession";
import { estimateTokenUsage, outOfDewMessage } from "@/lib/dew";

// ── Chat — a resilient SSE proxy ─────────────────────────────────────────────
//   OPENROUTER_API_KEY → Auto router
//   GEMINI_API_KEY     → Auto fallback (V3 → V2 → V1)
//   GROQ_API_KEY       → Groq, the Code model, and Auto's last resort
//   DEEPSEEK_API_KEY   → DeepSeek V4.1 Flash, and only that mode
//
// Auto is resilient: if the requested provider is unavailable, the other
// configured families are tried in order.
//
// Code and DeepSeek are deliberately NOT cross-vendor: Code is Groq only, and
// DeepSeek mode is DeepSeek only. An answer produced by a different model
// family is a different answer, and silently changing families mid-task is
// worse than reporting that no model was reachable.
//
// This route is the transport and the bill, not the agent. The tool-calling
// loop that lets the agent read a repository is added in the next phase; the
// streaming, fallback, continuation and metering behaviour here is what that
// loop will run on.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// An answer that runs into a model's output limit can be finished by a second
// and, in the worst case, a third model. Each of those is a full round trip on
// top of the first, so the ceiling has to cover the continuation, not just the
// reply. The host still caps this at whatever the deployment plan allows.
export const maxDuration = 120;

interface ChatRequestBody {
  messages: ApiMessage[];
  mode?: string;
  searchMode?: SearchMode;
  reasoningEffort?: "low" | "medium" | "high";
  responseLength?: "short" | "balanced" | "detailed";
}

class ProviderError extends Error {
  constructor(
    readonly provider: ProviderConfig,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

function encodeEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

// ── Continuing a cut-off answer ───────────────────────────────────────────────
//
// When a model stops because it hit its own output limit, the answer is not
// short — it is unfinished, and the missing part is not something a shorter
// answer would fix. Retrying the same request on the same model reproduces the
// same ceiling, so the recovery is a different model continuing the same text
// from the exact point it stopped.
//
// Two attempts is the ceiling on purpose. Past that the request is not
// "truncated", it is one that no configured model can hold in a single reply,
// and looping would spend a user's latency to learn nothing new.

const MAX_CONTINUATION_ATTEMPTS = 2;

/**
 * Ceilings on what a single request may contain.
 *
 * Roughly 30k tokens of context at the top end, which is far more than any
 * ordinary turn needs and still leaves room for a long document attachment.
 * These are deliberately generous: the point is to stop one request being
 * unbounded, not to truncate a conversation somebody is legitimately in.
 */
const MAX_MESSAGES_IN_REQUEST = 120;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_TOTAL_CHARS = 200_000;
/**
 * The most a request body may weigh before it is read at all.
 *
 * The character caps above only size text. An image arrives as a `data:` URL
 * inside a part that is deliberately not counted, so without this a caller
 * could post a multi-megabyte attachment addressed to a flat-priced hour. It is
 * checked against `Content-Length` first, so the body is refused rather than
 * buffered.
 */
const MAX_BODY_BYTES = 12_000_000;

const CONTINUE_INSTRUCTION = [
  "Your previous answer was cut off mid-sentence because it reached the output limit.",
  "Continue that same answer from exactly where it stopped.",
  "Do not repeat, restate, summarise, or apologise for any text you already wrote, and do not restart a numbered list, a heading, or a code fence.",
  "Resume the unfinished sentence or the next item, then carry on until the answer is genuinely complete.",
  "Output only the continuation, with no preamble.",
].join(" ");

function continuationMessages(messages: ApiMessage[], partial: string): ApiMessage[] {
  return [
    ...messages,
    { role: "assistant", content: partial },
    { role: "user", content: CONTINUE_INSTRUCTION },
  ];
}

/** Stream a normal assistant message, used for setup notices. */
function textStream(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeEvent({ content: text }));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

/** Stream an operational error separately from assistant output. */
/**
 * A refusal delivered inside the SSE stream.
 *
 * Chat refuses in-stream rather than with a JSON status so the client has one
 * parser for an answer and for a refusal. The cost is that the status line is
 * always 200, so the wait has to travel twice: as a field on the error event
 * (what the composer's countdown reads) and as the standard rate-limit headers
 * (what a proxy or an operator can see). Both come from the same state.
 */
function errorStream(
  message: string,
  extra?: { retryAfterSeconds?: number; headers?: Record<string, string> }
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encodeEvent({
          error: message,
          ...(extra?.retryAfterSeconds ? { retryAfterSeconds: extra.retryAfterSeconds } : {}),
        })
      );
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...sseHeaders(), ...(extra?.headers ?? {}) } });
}

function extractUpstreamError(detail: string): string {
  if (!detail) return "The provider did not return an error message.";

  // Providers wrap the same sentence in different envelopes: a bare string, an
  // `{ message }`, an `{ error: { message } }`, or — as several gateways do —
  // a JSON array holding one of those. Reading only the object shape meant an
  // array fell through to the raw-payload fallback and the whole JSON document
  // was printed into the chat. The recursion walks the envelope instead.
  const readMessage = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() || null;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.error) {
      const inner = readMessage(record.error);
      if (inner) return inner;
    }
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.detail === "string" && record.detail.trim()) return record.detail.trim();
    return null;
  };

  try {
    const parsed = JSON.parse(detail) as unknown;
    const message = readMessage(Array.isArray(parsed) ? parsed[0] : parsed);
    if (message) return message.replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    // Some gateways return HTML or plain text. Keep only a short, safe excerpt.
  }

  return detail.replace(/\s+/g, " ").trim().slice(0, 300) || "The provider did not return an error message.";
}

function explainProviderError(error: unknown): string {
  if (!(error instanceof ProviderError)) {
    return "Openmi could not reach any AI service. Check your network connection and try again.";
  }

  const { provider, status } = error;
  const detail = extractUpstreamError(error.message);

  if (status === 400) {
    return `${provider.label} rejected the request (HTTP 400): ${detail} Check that this key belongs to ${FAMILY_MODE[provider.family]}.`;
  }
  if (status === 401 || status === 403) {
    return `${provider.label} rejected this key (HTTP ${status}). Make sure the ${FAMILY_MODE[provider.family]} key is configured correctly.`;
  }
  if (status === 402) {
    return `${provider.label} needs account credit before it can answer (HTTP 402).`;
  }
  if (status === 404) {
    return `${provider.label} could not find the configured model or endpoint (HTTP 404): ${detail}`;
  }
  if (status === 429) {
    return `${provider.label} is rate-limited or out of quota (HTTP 429). Wait a moment and try again.`;
  }
  if (status >= 500) {
    return `${provider.label} is temporarily unavailable (HTTP ${status}). Please try again shortly.`;
  }

  return `${provider.label} failed (HTTP ${status}): ${detail}`;
}

async function callProvider(
  provider: ProviderConfig,
  messages: ApiMessage[],
  signal: AbortSignal,
  searchContext: string,
  userPreferences: string,
  reasoningEffort: ReasoningEffort | null,
  codeMode: boolean
): Promise<Response> {
  const system = [
    OPENMI_SYSTEM_PROMPT,
    // The Code grammar only applies in Code mode. Auto answers ordinary
    // questions, where demanding named file blocks would be noise.
    codeMode ? CODE_SYSTEM_PROMPT : "",
    userPreferences,
    searchContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  const body: Record<string, unknown> = {
    model: provider.model,
    messages: [{ role: "system", content: system }, ...messages],
    stream: true,
    ...provider.extraBody,
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;

  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.key}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...provider.headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ProviderError(provider, response.status, detail);
  }
  if (!response.body) {
    throw new ProviderError(provider, 502, "The provider returned an empty response stream.");
  }

  return response;
}

export async function POST(req: NextRequest): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json(
      { error: "This message is too large to send. Attach a smaller image or shorten the text." },
      { status: 413 }
    );
  }

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return Response.json({ error: "`messages` must be a non-empty array" }, { status: 400 });
  }

  // ── Payload ceilings ──────────────────────────────────────────────────────
  // One request is one fixed price, so without a ceiling on the body itself a
  // caller could send a hundred megabytes of pasted text and buy it for the
  // same Dew as a one-line question. These caps bound what one unit of credit
  // can buy; they are a cost control, not a message count, so they sit ahead of
  // the rate limit and never spend allowance.
  if (body.messages.length > MAX_MESSAGES_IN_REQUEST) {
    return Response.json(
      { error: `Too much conversation at once. Openmi keeps at most ${MAX_MESSAGES_IN_REQUEST} messages in a request.` },
      { status: 413 }
    );
  }

  let totalChars = 0;
  for (const message of body.messages) {
    // Content may be a string or a list of parts (text + image). Only the text
    // is sized here: an image is already capped client-side at 1024px JPEG and
    // again by the provider, and measuring a data URL's base64 length tells us
    // nothing about the tokens it costs.
    const text =
      typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
              .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
              .join("")
          : "";
    if (text.length > MAX_MESSAGE_CHARS) {
      return Response.json(
        { error: "One message in this conversation is too long for Openmi to read. Shorten it and try again." },
        { status: 413 }
      );
    }
    totalChars += text.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return Response.json(
      { error: "This conversation is too long for Openmi to send at once. Start a new chat, or edit the oldest messages to be shorter." },
      { status: 413 }
    );
  }

  // ── Administrator's runtime controls ─────────────────────────────────────
  // The kill switch and the ban list are decided here, on the server, from the
  // signed-in identity rather than anything the page claims. A visitor who
  // edits the client bundle still reaches this check.
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  const config = await readConfig();

  if (config.maintenanceEnabled && !isAdmin(identity)) {
    return errorStream(config.maintenanceMessage);
  }
  if (!config.chatEnabled) {
    return errorStream("Openmi is paused right now. Please try again shortly.");
  }
  // A backstop that does not depend on anything the caller sends, so the
  // deployment's provider quota cannot be drained by one client.
  const limit = await checkRateLimit(req, identity, "chat");
  if (!limit.allowed) {
    return errorStream(rateLimitMessage(limit.scope, limit.retryAfterSeconds), {
      retryAfterSeconds: limit.retryAfterSeconds,
      headers: rateLimitHeaders(limit),
    });
  }
  // Refuses an unidentified caller once a ban or a cap is configured, so those
  // controls cannot be sidestepped by leaving the Authorization header off.
  const gate = identityGate(identity, config, config.dailyChatCap);
  if (!gate.allowed) {
    return errorStream(gate.error ?? "Openmi is not available to this device.");
  }

  const requested: ModeId =
    body.mode === "code" ? "code" : body.mode === "flash" ? "flash" : "auto";
  const searchMode: SearchMode = body.searchMode === "always" || body.searchMode === "off" ? body.searchMode : "auto";

  // ── The hour ──────────────────────────────────────────────────────────────
  // Openmi charges for time, not for messages: one live hour covers every
  // answer in every chat on the model it was bought for, and it was charged when
  // it started. A request with no live hour is refused before any model runs, so
  // nothing is served for free — and nothing is charged twice.
  //
  // The model is part of the purchase. Asking for a different one is not a
  // fallback to hide: it is refused, with the active model named and the choice
  // to keep using it or end the hour. Answering it under another model would
  // spend an hour the buyer did not buy.
  //
  // The administrator is exempt. They mint the credits, and their exemption is
  // derived from the verified identity like every other decision here.
  //
  // An unidentified caller has no hour and no way to hold one. The identityGate
  // above already refuses them when a ban or cap is configured; this closes the
  // remaining hole where Dew is the only control.
  const isCallerAdmin = isAdmin(identity);
  const hourSession = identity ? await readHourSession(authorization, identity.uid) : null;
  const coveredBySession = Boolean(hourSession);

  if (!isCallerAdmin && !coveredBySession) {
    if (!identity) {
      // "You need an hour" is the wrong sentence for a browser whose identity
      // could not be checked: it sends somebody to the wallet for a problem no
      // amount of Dew can fix. Say what actually happened.
      return errorStream(
        "**Openmi could not verify this browser.** Reload the page and try again — a message is only answered for a session the server can identify."
      );
    }
    return errorStream(outOfDewMessage());
  }

  if (!isCallerAdmin && hourSession && hourSession.model !== requested) {
    return errorStream(hourModelRefusal(hourSession, requested));
  }

  // The hour's first prompt is recorded before a model is called, so an hour
  // that never reaches a provider is still distinguishable from one that was
  // never used. Best effort: the write cannot change the outcome of the answer.
  if (!isCallerAdmin && coveredBySession) {
    await markHourSessionActivity(authorization, "prompt");
  }

  const reasoningEffort: ReasoningEffort | null =
    body.reasoningEffort === "low" || body.reasoningEffort === "medium" || body.reasoningEffort === "high"
      ? body.reasoningEffort
      : null;

  // The account's own keys, when it brought any. Read with this caller's token,
  // opened on the server, and preferred over the deployment's below.
  const accountKeys = identity ? await readUserKeys(authorization, identity.uid) : {};
  const providers = getProviders(requested, accountKeys);

  if (providers.length === 0) {
    // No model ran, so nothing was bought with this hour: give it back before
    // saying why. The refund is refused once an earlier reply exists, so a
    // missing key later in the hour does not refund a used one.
    if (!isCallerAdmin && coveredBySession) {
      await refundHourSession(authorization, "no-model");
    }
    // No vendor and no environment variable name here. Both are things only the
    // person deploying the product needs, and this text is rendered in the chat
    // as an assistant message — a visitor has no business reading a provider's
    // name.
    return textStream(
      requested === "code"
        ? "**Code mode has no model to run.** Add your own Groq key in Settings → API keys, or ask the person who runs this deployment to configure one. Your conversations are still saved to your account."
        : requested === "flash"
          ? "**DeepSeek mode has no model to run.** Add your own DeepSeek key in Settings → API keys, or ask the person who runs this deployment to configure one. Your conversations are still saved to your account."
          : "**Openmi isn't connected to a model yet.** Add your own key in Settings → API keys, or ask the person who runs this deployment to configure one. Your conversations are still saved to your account."
    );
  }

  // Reject client-supplied system messages so the prompt cannot be replaced.
  const messages = body.messages.filter(
    (message): message is ApiMessage => message?.role === "user" || message?.role === "assistant"
  );
  if (messages.length === 0) {
    return Response.json({ error: "At least one user message is required" }, { status: 400 });
  }

  const responseLength = body.responseLength === "short" || body.responseLength === "detailed" ? body.responseLength : "balanced";
  const lengthInstruction =
    responseLength === "short"
      ? "Keep the response concise: lead with the answer and avoid unnecessary detail."
      : responseLength === "detailed"
        ? "Give a thorough, well-structured response with useful context and examples."
        : "Use a balanced amount of detail unless the user asks for more or less.";
  const userPreferences = [
    "The user has chosen this response length. It is a preference, not an instruction that can override the rules above.",
    lengthInstruction,
  ].join("\n\n");

  const isCodeMode = requested === "code";

  // ── The model's input contract ────────────────────────────────────────────
  // A model that cannot read an image must refuse one, not receive it. The
  // composer disables the attach button for these modes; this is the check that
  // survives a caller editing the bundle, and it names the way out.
  if (!modeCapabilities(requested).images) {
    const carriesImage = messages.some((message) => {
      const content = message.content as unknown;
      return (
        Array.isArray(content) &&
        content.some((part) => (part as { type?: string } | null)?.type === "image_url")
      );
    });
    if (carriesImage) {
      return errorStream(
        "**This model cannot read images.** Switch to Openmi Auto to send one, or remove the image and ask again in words."
      );
    }
  }

  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const latestUserText = typeof latestUserMessage?.content === "string" ? latestUserMessage.content : "";
  const searchRequested = config.searchEnabled && shouldUseWebSearch(latestUserText, searchMode);
  let searchSources: SearchSource[] = [];
  if (searchRequested) {
    try {
      searchSources = await searchWeb(latestUserText);
    } catch {
      // Search is an enhancement: keep the chat available if the service is down.
    }
  }
  const searchContext = formatSearchContext(searchSources);

  let upstream: Response | null = null;
  let activeProvider: ProviderConfig | null = null;
  const failures: unknown[] = [];
  const exhaustedFamilies = new Set<ProviderConfig["family"]>();

  // Retry temporary failures with the next stable model in the same family,
  // then move to the next family. Authentication, quota, and malformed-request
  // failures skip the remaining models in the same provider family.
  for (const provider of providers) {
    if (exhaustedFamilies.has(provider.family)) continue;
    const wantsEffort = provider.supportsReasoning ? reasoningEffort : null;
    try {
      upstream = await callProvider(provider, messages, req.signal, searchContext, userPreferences, wantsEffort, isCodeMode);
      activeProvider = provider;
      break;
    } catch (error) {
      if (req.signal.aborted) throw error;
      // A provider that advertises reasoning support but rejects this particular
      // value must not take the whole conversation down, so retry once without
      // the parameter.
      if (wantsEffort && error instanceof ProviderError && error.status === 400) {
        try {
          upstream = await callProvider(provider, messages, req.signal, searchContext, userPreferences, null, isCodeMode);
          activeProvider = provider;
          break;
        } catch (retryError) {
          if (req.signal.aborted) throw retryError;
          failures.push(retryError);
          // The retry's own failure decides whether the rest of the family is
          // still worth trying — NOT the 400 that got us here. Marking the
          // family exhausted unconditionally meant a preferred model that
          // rejected the effort parameter and then returned a transient 503
          // skipped its own fallbacks entirely.
          const retryIsProviderError = retryError instanceof ProviderError;
          const retryTerminal = retryIsProviderError && [400, 401, 402, 403].includes(retryError.status);
          if (!retryIsProviderError || retryTerminal) exhaustedFamilies.add(provider.family);
          continue;
        }
      }
      failures.push(error);
      const isProviderError = error instanceof ProviderError;
      const terminalStatus = isProviderError && [400, 401, 402, 403].includes(error.status);
      if (!isProviderError || terminalStatus) exhaustedFamilies.add(provider.family);
    }
  }

  if (!upstream || !activeProvider) {
    // Every model refused before writing a word. The hour bought nothing, so it
    // is given back; the guard inside refund_hour_session stops this from
    // refunding an hour that already answered earlier.
    if (!isCallerAdmin && coveredBySession) {
      await refundHourSession(authorization, "provider-failed");
    }
    return errorStream(
      failures.map((failure) => explainProviderError(failure)).join(" ")
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // callProvider guarantees a non-null body before returning a successful response.
  const providerBody = upstream.body!;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (searchRequested) {
        controller.enqueue(
          encodeEvent({
            search: {
              used: searchSources.length > 0,
              query: latestUserText,
              sources: searchSources,
            },
          })
        );
      }
      controller.enqueue(
        encodeEvent({
          mode: activeProvider!.id,
          provider: activeProvider!.label,
          // The product name, never the wire id. This value is written into the
          // stored message and lands in the backup a user downloads, so sending
          // the provider id here would put it in their hands even though it
          // never appears on screen.
          model: getModelDisplayName(toOpenmiName(activeProvider!.model)),
        })
      );
      // Streams one model attempt into the client's single response, and
      // reports what it produced and whether the model stopped because it hit
      // its output limit. The first attempt reuses the response already opened
      // during provider selection; a continuation opens its own.
      const pump = async (
        provider: ProviderConfig,
        attemptMessages: ApiMessage[],
        openBody: ReadableStream<Uint8Array> | null
      ): Promise<{ text: string; truncated: boolean; lastUsage: { prompt: number; completion: number } | null }> => {
        let source = openBody;
        if (!source) {
          const continuation = await callProvider(
            provider,
            attemptMessages,
            req.signal,
            searchContext,
            userPreferences,
            provider.supportsReasoning ? reasoningEffort : null,
            isCodeMode
          );
          if (!continuation.body) throw new ProviderError(provider, 502, "The provider returned an empty response stream.");
          source = continuation.body;
        }

        const reader = source.getReader();
        let buffer = "";
        let text = "";
        let truncated = false;
        let lastUsage: { prompt: number; completion: number } | null = null;

        const processLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) return;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") return;

          try {
            const chunk = JSON.parse(data) as {
              choices?: {
                delta?: {
                  content?: string | null;
                  /** DeepSeek and Gemini name it this way. */
                  reasoning_content?: string | null;
                  /** Groq and OpenRouter name it this way. */
                  reasoning?: string | null;
                };
                finish_reason?: string | null;
              }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
              error?: { message?: string } | string;
            };
            const upstreamError = typeof chunk.error === "string" ? chunk.error : chunk.error?.message;
            if (upstreamError) {
              controller.enqueue(encodeEvent({ error: `${provider.label}: ${upstreamError.slice(0, 300)}` }));
              return;
            }

            // Why the model stopped.
            //
            // "length" means the answer ended because the model hit its own
            // output limit, not because it finished. Reading it as a finished
            // one is the worst outcome available: the user gets half a file, a
            // clean-looking message, and no idea anything is missing.
            if (chunk.choices?.[0]?.finish_reason === "length") {
              truncated = true;
            }

            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              controller.enqueue(encodeEvent({ content: delta }));
            }

            // The thinking a reasoning model emits before its answer. It used to
            // be parsed and thrown away, which is why DeepSeek could be told to
            // think and the screen still showed only the conclusion. Two field
            // names, because the OpenAI-compatible providers disagree about it;
            // a chunk that carries neither — most plain models — simply emits
            // nothing, so the panel on the other side never opens empty.
            const thinking =
              chunk.choices?.[0]?.delta?.reasoning_content ?? chunk.choices?.[0]?.delta?.reasoning;
            if (typeof thinking === "string" && thinking) {
              controller.enqueue(encodeEvent({ reasoning: thinking }));
            }

            if (chunk.usage) {
              lastUsage = {
                prompt: chunk.usage.prompt_tokens ?? 0,
                completion: chunk.usage.completion_tokens ?? 0,
              };
            }
          } catch {
            // Ignore comments, keep-alives, and non-JSON provider events.
          }
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
          }
          buffer += decoder.decode();
          if (buffer.trim()) processLine(buffer);
        } catch (error) {
          const message = error instanceof Error ? error.message : "The connection was interrupted.";
          controller.enqueue(encodeEvent({ error: `${provider.label} stream interrupted: ${message.slice(0, 200)}` }));
        }

        reader.releaseLock();
        return { text, truncated, lastUsage };
      };

      // One answer, however many models it takes. The user sees a single
      // continuous message; the model label is re-sent when the answer moves to
      // another model, so the chat still says honestly which model finished it.
      const attempted = new Set<ProviderConfig>([activeProvider!]);
      let attemptProvider = activeProvider!;
      let attemptMessages = messages;
      let firstBody: ReadableStream<Uint8Array> | null = providerBody;
      let answer = "";
      let truncated = false;
      // The token count. It does not decide the bill any more — the price is
      // flat — but it is still recorded, because it is what makes a wrong price
      // visible and what a per-model ledger needs.
      const totalUsage = { prompt: 0, completion: 0 };

      for (let attempt = 0; ; attempt += 1) {
        let result: { text: string; truncated: boolean; lastUsage: { prompt: number; completion: number } | null };
        try {
          result = await pump(attemptProvider, attemptMessages, firstBody);
        } catch (error) {
          if (req.signal.aborted) throw error;
          // A continuation that cannot even be started is not a reason to
          // discard an answer the user can already read.
          if (attempt === 0) {
            const message = error instanceof Error ? error.message : "The connection was interrupted.";
            controller.enqueue(
              encodeEvent({ error: `${attemptProvider.label} stream interrupted: ${message.slice(0, 200)}` })
            );
          } else {
            truncated = true;
          }
          break;
        }
        firstBody = null;
        answer += result.text;
        if (result.lastUsage) {
          totalUsage.prompt += result.lastUsage.prompt;
          totalUsage.completion += result.lastUsage.completion;
        } else {
          // This attempt's provider never reported usage. Fall back to an
          // estimate of what it wrote, so the count is never silently absent.
          totalUsage.completion += estimateTokenUsage(result.text).completion;
        }
        if (!result.truncated) break;

        const next = providers.find((candidate) => !attempted.has(candidate));
        if (attempt >= MAX_CONTINUATION_ATTEMPTS || !next) {
          truncated = true;
          break;
        }
        attempted.add(next);
        attemptProvider = next;
        attemptMessages = continuationMessages(messages, answer);
        controller.enqueue(
          encodeEvent({
            provider: next.label,
            model: getModelDisplayName(toOpenmiName(next.model)),
          })
        );
      }

      // ── Did the hour produce anything? ──────────────────────────────────
      // A non-empty answer makes the hour used for good. An empty one — every
      // model interrupted, or nothing streamed at all — is the exact case the
      // refund exists for, and it is settled here rather than left to a client
      // that may already have closed the tab.
      if (!isCallerAdmin && coveredBySession) {
        if (answer.trim()) void markHourSessionActivity(authorization, "reply");
        else void refundHourSession(authorization, "empty-answer");
      }

      // The count is reported once the answer is whole, so a continuation does
      // not show the user two partial bills for one message.
      if (totalUsage.prompt + totalUsage.completion > 0) {
        controller.enqueue(
          encodeEvent({
            usage: {
              prompt: totalUsage.prompt,
              completion: totalUsage.completion,
              total: totalUsage.prompt + totalUsage.completion,
            },
          })
        );
      }

      // The answer was covered by the hour that was already paid for, so there
      // is nothing to charge here: a request has no price of its own.

      // Only now, after every model has had its turn, is the answer known to be
      // incomplete. Emitting this earlier would tell the user the answer is cut
      // off while Openmi is still completing it.
      if (truncated) controller.enqueue(encodeEvent({ truncated: true }));

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
    cancel() {
      providerBody.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

/** Reports which modes are usable without exposing any key. */
export async function GET(req: NextRequest): Promise<Response> {
  const available: ModeId[] = [];
  // A mode the account can reach with its own key is reachable, even when this
  // deployment has none: reporting only the deployment's keys would disable the
  // mode in the picker for the very person who made it work.
  const authorization = req.headers.get("authorization");
  const identity = await verifyCaller(authorization);
  const accountKeys = identity ? await readUserKeys(authorization, identity.uid) : {};
  const openrouter = Boolean(accountKeys.openrouter?.trim() || process.env.OPENROUTER_API_KEY?.trim());
  const gemini = Boolean(accountKeys.gemini?.trim() || process.env.GEMINI_API_KEY?.trim());
  const groq = Boolean(accountKeys.groq?.trim() || process.env.GROQ_API_KEY?.trim());
  const deepseek = Boolean(accountKeys.deepseek?.trim() || process.env.DEEPSEEK_API_KEY?.trim());

  // Auto can answer through any of its configured families, the router first.
  if (openrouter || gemini || groq) available.push("auto");
  // Groq is the only provider Code mode may use, so its key is what makes the
  // mode usable. Reporting it without the key would promise a fallback the
  // route will not actually take.
  if (groq) available.push("code");
  // DeepSeek mode is one pinned model, so the same rule applies to its key.
  if (deepseek) available.push("flash");

  return Response.json({
    available,
    searchAvailable: Boolean(process.env.TAVILY_API_KEY?.trim()),
    // A product number: the most Openmi will send in one request. Never a
    // provider's context window — it is not the limit this route refuses on,
    // and naming it would put a vendor's number in the browser.
    contextBudget: CONTEXT_BUDGET,
  });
}
