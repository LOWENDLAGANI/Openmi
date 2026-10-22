import { env } from '../env.js';
import { AppError, issue, summarizeIssues } from '../errors.js';
import type { PatchSet, Issue } from '../../shared/types.js';
import { validatePatchSet } from './policy.js';

const SYSTEM_PROMPT = `You are OpenMi, a coding agent that edits GitHub repositories from a phone prompt.

Respond ONLY with a JSON object, no markdown fences, of the form:
{
  "summary": "one-line human description of the change",
  "files": [
    { "path": "relative/path.ext", "op": "create" | "update", "content": "full file contents" }
  ]
}

Rules:
- Only "create" or "update" ops. You cannot delete files.
- Full file contents only (no diffs, no snippets).
- At most 12 files, each ≤256 KB.
- Never touch .github/**, .env*, keys, or binaries.
- If the prompt is ambiguous, make the smallest reasonable change and note it in summary.
- If you cannot safely fulfil the prompt, return {"summary":"...","files":[]} and explain.`;

export interface ModelResult {
  patch: PatchSet;
  usage: { prompt: number; completion: number; total: number };
  raw: string;
  /** Every provider/model that was tried, in order. */
  attempts: ProviderAttempt[];
}

export interface ProviderAttempt {
  provider: 'openrouter' | 'groq';
  model: string;
  ok: boolean;
  status?: number;
  reason?: string;
}

export interface ProviderTarget {
  provider: 'openrouter' | 'groq';
  model: string;
}

type ChatResult = { content: string; usage: ModelResult['usage'] };

// How a provider failure should be treated.
export type FailureKind =
  | 'model_not_found' // the slug does not resolve (retired / renamed)
  | 'auth' // bad or missing API key
  | 'rate_limited' // 429
  | 'transient' // 5xx — provider down or overloaded
  | 'invalid_request' // 400 and friends
  | 'unknown';

export function classifyProviderStatus(status: number): FailureKind {
  if (status === 404) return 'model_not_found';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 409 || (status >= 500 && status <= 599)) return 'transient';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

// The order models are tried in: the configured OpenRouter model, its
// fallbacks, then Groq when a key is present.
export function buildProviderChain(): ProviderTarget[] {
  const chain: ProviderTarget[] = [];
  const seen = new Set<string>();
  const push = (provider: ProviderTarget['provider'], model: string) => {
    if (!model) return;
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    chain.push({ provider, model });
  };
  if (env.openRouterApiKey()) {
    push('openrouter', env.model());
    for (const m of env.modelFallbacks()) push('openrouter', m);
  }
  if (env.groqApiKey()) {
    push('groq', env.groqModel());
  }
  return chain;
}

async function chatOpenRouter(
  model: string,
  messages: Array<{ role: string; content: string }>,
): Promise<ChatResult> {
  const key = env.openRouterApiKey();
  if (!key) throw new AppError('CONFIG_ERROR', 'OPENROUTER_API_KEY not set');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': env.appOrigin() ?? 'https://openmi.local',
      'X-Title': 'OpenMi',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    throw await providerError('openrouter', model, res);
  }
  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  const u = data.usage ?? {};
  return {
    content,
    usage: {
      prompt: u.prompt_tokens ?? 0,
      completion: u.completion_tokens ?? 0,
      total: u.total_tokens ?? 0,
    },
  };
}

async function chatGroq(
  model: string,
  messages: Array<{ role: string; content: string }>,
): Promise<ChatResult> {
  const key = env.groqApiKey();
  if (!key) throw new AppError('CONFIG_ERROR', 'GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    throw await providerError('groq', model, res);
  }
  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  const u = data.usage ?? {};
  return {
    content,
    usage: {
      prompt: u.prompt_tokens ?? 0,
      completion: u.completion_tokens ?? 0,
      total: u.total_tokens ?? 0,
    },
  };
}

// Turn a non-2xx provider response into an AppError that says what went wrong
// and whether trying the next model could help.
async function providerError(
  provider: string,
  model: string,
  res: Response,
): Promise<AppError> {
  const text = await res.text().catch(() => '');
  const kind = classifyProviderStatus(res.status);
  const reason = text.slice(0, 300) || res.statusText || 'request failed';
  const source = `${provider}/${model}`;
  const detail = issue(
    kind.toUpperCase(),
    `${source} returned ${res.status}: ${reason}`,
    { source, status: res.status },
  );
  if (kind === 'model_not_found') {
    return new AppError(
      'AI_PROVIDER_ERROR',
      `model "${model}" is not available on ${provider} (HTTP ${res.status})`,
      { details: { issues: [detail], kind }, retryable: false },
    );
  }
  if (kind === 'auth') {
    return new AppError(
      'CONFIG_ERROR',
      `${provider} rejected the API key (HTTP ${res.status})`,
      { details: { issues: [detail], kind }, retryable: false },
    );
  }
  if (kind === 'invalid_request') {
    return new AppError(
      'AI_PROVIDER_ERROR',
      `${source} rejected the request (HTTP ${res.status})`,
      { details: { issues: [detail], kind }, retryable: false },
    );
  }
  // rate_limited / transient / unknown -> retryable, try the next model.
  return new AppError(
    'AI_PROVIDER_ERROR',
    `${source} failed (HTTP ${res.status}): ${reason}`,
    { details: { issues: [detail], kind }, retryable: true },
  );
}

export function parsePatch(raw: string): PatchSet {
  let text = raw.trim();
  // Strip accidental markdown fences.
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch {
    // Try to extract the first {...} block.
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) {
      throw new AppError('AI_OUTPUT_INVALID', 'model output is not JSON', {
        details: {
          issues: [
            issue('NOT_JSON', 'model output is not JSON', { source: 'model' }),
          ],
        },
      });
    }
    try {
      obj = JSON.parse(m[0]);
    } catch (e: any) {
      throw new AppError('AI_OUTPUT_INVALID', `model output is not valid JSON: ${e.message}`, {
        details: {
          issues: [issue('INVALID_JSON', `model output is not valid JSON: ${e.message}`, { source: 'model' })],
        },
      });
    }
  }
  const patch: PatchSet = {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    files: Array.isArray(obj.files) ? obj.files : [],
  };
  validatePatchSet(patch);
  return patch;
}

export async function generatePatch(
  prompt: string,
  repoFullName: string,
  context: string,
): Promise<ModelResult> {
  const userContent = `Repository: ${repoFullName}\n\nUser prompt: ${prompt}\n\nRepository context (selected files):\n${context || '(no context files selected)'}\n\nReturn the JSON patch object now.`;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  const chain = buildProviderChain();
  if (chain.length === 0) {
    throw new AppError('CONFIG_ERROR', 'no model provider configured (set OPENROUTER_API_KEY or GROQ_API_KEY)');
  }

  const attempts: ProviderAttempt[] = [];
  const issues: Issue[] = [];
  let onlyInvalidOutput = true;

  for (const target of chain) {
    const source = `${target.provider}/${target.model}`;
    try {
      const { content, usage } =
        target.provider === 'groq'
          ? await chatGroq(target.model, messages)
          : await chatOpenRouter(target.model, messages);
      const patch = parsePatch(content);
      attempts.push({ provider: target.provider, model: target.model, ok: true });
      return { patch, usage, raw: content, attempts };
    } catch (e: any) {
      const isOutputProblem = e instanceof AppError && e.code === 'AI_OUTPUT_INVALID';
      const status = e?.details?.issues?.[0]?.status as number | undefined;
      attempts.push({
        provider: target.provider,
        model: target.model,
        ok: false,
        status,
        reason: e?.message ?? String(e),
      });
      if (e instanceof AppError) {
        issues.push(...(e.details?.issues as Issue[] | undefined ?? []));
        if (!isOutputProblem) onlyInvalidOutput = false;
        // A bad API key will not be fixed by another model: stop immediately.
        if (e.code === 'CONFIG_ERROR') {
          throw new AppError(e.code, e.message, {
            details: { issues: [...issues], attempts },
            retryable: false,
          });
        }
      } else {
        onlyInvalidOutput = false;
        issues.push(issue('PROVIDER_ERROR', `${source} failed: ${e?.message ?? e}`, { source }));
      }
      // Otherwise: try the next model in the chain.
    }
  }

  const detail = {
    issues,
    attempts,
    providersTried: attempts.length,
  };
  if (onlyInvalidOutput) {
    throw new AppError('AI_OUTPUT_INVALID', summarizeIssues(issues), {
      details: detail,
      retryable: false,
    });
  }
  throw new AppError(
    'AI_PROVIDER_ERROR',
    `all ${attempts.length} model provider attempt(s) failed`,
    { details: detail, retryable: true },
  );
}
