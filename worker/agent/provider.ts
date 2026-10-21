import type { AppConfig } from '../env.js';
import { AppError } from '../lib/errors.js';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletion {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface CompletionOptions {
  model: string;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  temperature?: number;
  maxTokens?: number;
}

export interface AiProvider {
  readonly id: 'openrouter' | 'groq';
  complete(messages: AiMessage[], options: CompletionOptions): Promise<AiCompletion>;
}

const AI_TIMEOUT_MS = 120_000;

interface OpenAiChatResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string | number };
}

async function postChat(
  provider: 'openrouter' | 'groq',
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<AiCompletion> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new AppError('AI_UNAVAILABLE', `${provider} request failed`, {
      cause,
      retryable: true,
    });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    throw new AppError(
      'AI_UNAVAILABLE',
      `${provider} returned ${response.status}: ${detail.slice(0, 200)}`,
      { cause: detail, retryable },
    );
  }

  const payload = (await response.json()) as OpenAiChatResponse;
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new AppError('AI_INVALID_OUTPUT', `${provider} returned an empty completion`, {
      retryable: true,
    });
  }

  return {
    content,
    model: payload.model ?? String(body.model ?? 'unknown'),
    promptTokens: payload.usage?.prompt_tokens ?? 0,
    completionTokens: payload.usage?.completion_tokens ?? 0,
  };
}

function openRouterProvider(apiKey: string): AiProvider {
  return {
    id: 'openrouter',
    async complete(messages, options) {
      return postChat(
        'openrouter',
        'https://openrouter.ai/api/v1/chat/completions',
        {
          authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://openmi.app',
          'X-Title': 'OpenMi',
        },
        {
          model: options.model,
          messages,
          temperature: options.temperature ?? 0.15,
          max_tokens: options.maxTokens ?? 8000,
          ...(options.jsonSchema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: options.jsonSchema.name,
                    schema: options.jsonSchema.schema,
                  },
                },
              }
            : {}),
        },
      );
    },
  };
}

function groqProvider(apiKey: string, model: string): AiProvider {
  return {
    id: 'groq',
    async complete(messages, options) {
      // Groq supports JSON mode but not JSON-schema mode, so the schema is
      // restated inside the prompt by the caller.
      return postChat(
        'groq',
        'https://api.groq.com/openai/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          messages,
          temperature: options.temperature ?? 0.15,
          max_tokens: options.maxTokens ?? 8000,
          response_format: { type: 'json_object' },
        },
      );
    },
  };
}

/** Primary first, then optional fallback. Both speak the OpenAI chat shape. */
export function providersFor(config: AppConfig): AiProvider[] {
  const providers: AiProvider[] = [openRouterProvider(config.openRouterApiKey)];
  if (config.groqApiKey) {
    providers.push(groqProvider(config.groqApiKey, 'llama-3.3-70b-versatile'));
  }
  return providers;
}
