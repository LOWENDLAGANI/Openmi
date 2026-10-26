// ── Provider configuration (server only) ─────────────────────────────────────
// The one place an endpoint, a key and a wire model id are assembled, so the
// chat route and the admin model-health probe talk to exactly the same models
// with the same settings. Nothing here may be imported by a client component:
// these strings carry provider names and, via `key`, credentials.

import type { ModeId } from "./models";
import { AUTO_ENGINE, GEMINI_ENGINE, GEMINI_FALLBACKS, GROQ_MODELS, toOpenmiName } from "./modelEngines";

export type ProviderFamily = "openrouter" | "gemini" | "groq";

export interface ProviderConfig {
  id: ModeId;
  family: ProviderFamily;
  label: string;
  url: string;
  key: string;
  model: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /**
   * Whether this exact model honours `reasoning_effort`. It is not a property
   * of the vendor — Groq serves both a reasoning model and a plain one behind
   * the same API — so it is tracked per configuration.
   */
  supportsReasoning: boolean;
}

/** Which mode a provider family belongs to, for user-facing error copy. */
export const FAMILY_MODE: Record<ProviderFamily, string> = {
  openrouter: "Openmi Auto",
  gemini: "the Auto fallback",
  groq: "Groq",
};

/**
 * The providers one request may use, with the caller's own keys preferred.
 *
 * `accountKeys` is the key the account brought for a provider, already opened by
 * lib/providerKeys.ts on the server. It wins over the deployment's, which stays
 * as the fallback: a person who removes their key, or whose key is revoked,
 * should fall back to the deployment rather than lose the mode entirely. Neither
 * key is ever named in a response — only the vendor is, and only in the copy
 * that tells the reader where to fix something.
 */
export function getProviders(
  requested: ModeId,
  accountKeys: Partial<Record<ProviderFamily, string>> = {}
): ProviderConfig[] {
  const openrouterKey = accountKeys.openrouter?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  const geminiKey = accountKeys.gemini?.trim() || process.env.GEMINI_API_KEY?.trim();
  const groqKey = accountKeys.groq?.trim() || process.env.GROQ_API_KEY?.trim();

  const openrouter: ProviderConfig | null = openrouterKey
    ? {
        id: "auto",
        family: "openrouter",
        label: "Openmi Auto",
        url: "https://openrouter.ai/api/v1/chat/completions",
        key: openrouterKey,
        model: AUTO_ENGINE,
        supportsReasoning: true,
        headers: {
          "HTTP-Referer": "https://openmi-ai.vercel.app",
          "X-Title": "Openmi",
        },
        extraBody: {
          provider: { allow_fallbacks: true },
          stream_options: { include_usage: true },
        },
      }
    : null;

  // The preferred model can return a temporary 503 while it has no serving
  // capacity. The older versions are stable and remain available as immediate
  // fallbacks for Auto. The wire names are provider detail and never reach the
  // user.
  const geminiModels = [GEMINI_ENGINE, ...GEMINI_FALLBACKS];
  const gemini: ProviderConfig[] = geminiKey
    ? geminiModels.map((model) => ({
        // Gemini no longer serves Code mode, so it is only ever reached through
        // Auto; reporting it under the mode that asked keeps the SSE label true.
        id: requested,
        family: "gemini" as const,
        label: toOpenmiName(model),
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        key: geminiKey,
        model,
        supportsReasoning: true,
      }))
    : [];

  // Groq is the only provider Code mode may use, and the last line of defence
  // for Auto: a separate vendor with its own quota, so when every other model
  // is down, rate-limited, or out of capacity the chat still answers instead of
  // erroring out.
  //
  // Every entry is a comparable-tier model rather than a progressively weaker
  // one, and only GPT-OSS honours reasoning_effort.
  const groq: ProviderConfig[] = groqKey
    ? GROQ_MODELS.map(({ model, supportsReasoning }) => ({
        id: requested,
        family: "groq" as const,
        label: "Groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        key: groqKey,
        model,
        supportsReasoning,
        extraBody: { stream_options: { include_usage: true } },
      }))
    : [];

  // Code mode never leaves its own family. OpenRouter and Gemini are excluded
  // from its fallback chain entirely, so an outage produces a clear error
  // instead of code written by a model the user did not ask for.
  if (requested === "code") return [...groq];

  // Auto prefers the router, then the stable fallbacks, then Groq.
  return [...(openrouter ? [openrouter] : []), ...gemini, ...groq];
}
