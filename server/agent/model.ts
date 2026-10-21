import { env } from '../env.js';
import { AppError } from '../errors.js';
import type { PatchSet } from '../../shared/types.js';
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
}

async function callOpenRouter(messages: Array<{ role: string; content: string }>): Promise<{ content: string; usage: ModelResult['usage'] }> {
  const key = env.openRouterApiKey();
  if (!key) throw new AppError('CONFIG_ERROR', 'OPENROUTER_API_KEY not set');
  const model = env.model();
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
    const text = await res.text().catch(() => '');
    throw new AppError('AI_PROVIDER_ERROR', `OpenRouter ${res.status}: ${text.slice(0, 200)}`, { retryable: true });
  }
  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  const u = data.usage ?? {};
  return { content, usage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, total: u.total_tokens ?? 0 } };
}

async function callGroq(messages: Array<{ role: string; content: string }>): Promise<{ content: string; usage: ModelResult['usage'] }> {
  const key = env.groqApiKey();
  if (!key) throw new AppError('CONFIG_ERROR', 'GROQ_API_KEY not set');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.2,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AppError('AI_PROVIDER_ERROR', `Groq ${res.status}: ${text.slice(0, 200)}`, { retryable: true });
  }
  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  const u = data.usage ?? {};
  return { content, usage: { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0, total: u.total_tokens ?? 0 } };
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
    if (!m) throw new AppError('AI_OUTPUT_INVALID', 'model output is not JSON');
    obj = JSON.parse(m[0]);
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

  let lastErr: unknown;
  // Primary: OpenRouter. Fallback: Groq if configured and OpenRouter fails.
  try {
    const { content, usage } = await callOpenRouter(messages);
    const patch = parsePatch(content);
    return { patch, usage, raw: content };
  } catch (e) {
    lastErr = e;
    if (!env.groqApiKey()) throw e;
    if (e instanceof AppError && e.code === 'AI_OUTPUT_INVALID') throw e; // don't retry invalid output on fallback
  }
  const { content, usage } = await callGroq(messages);
  try {
    const patch = parsePatch(content);
    return { patch, usage, raw: content };
  } catch (e) {
    throw lastErr instanceof Error ? lastErr : e;
  }
}
