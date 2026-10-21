import { z } from 'zod';
import type { AppConfig, Env } from '../env.js';
import { loadConfig } from '../env.js';
import { AppError, isAppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import type { GeneratedPatch, RepoContext } from '../workflows/types.js';
import { validatePatchSet, type TreeEntryLike } from './patch.js';
import {
  PATCH_SCHEMA_NAME,
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from './prompt.js';
import { providersFor, type AiMessage, type AiProvider } from './provider.js';

export const aiPatchSchema = z.object({
  summary: z.string().min(1).max(2000),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        operation: z.enum(['create', 'update']),
        content: z.string(),
        reason: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(20),
});

type AiPatchPayload = z.infer<typeof aiPatchSchema>;

function jsonSchemaForModel(): Record<string, unknown> {
  const schema = z.toJSONSchema(aiPatchSchema, { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** Extracts a JSON object from a model reply that may include fences or prose. */
export function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new AppError('AI_INVALID_OUTPUT', 'Model reply was not valid JSON');
  }
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 6).map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

interface AttemptOutcome {
  payload: AiPatchPayload;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

async function runProvider(
  provider: AiProvider,
  config: AppConfig,
  messages: AiMessage[],
  tree: TreeEntryLike[],
): Promise<AttemptOutcome> {
  const conversation = [...messages];
  let lastErrors: string[] = ['(no attempt made)'];
  let promptTokens = 0;
  let completionTokens = 0;
  let model = config.model;

  // Two shots per provider: one generation, one validator-guided repair.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const completion = await provider.complete(conversation, {
      model: config.model,
      jsonSchema: { name: PATCH_SCHEMA_NAME, schema: jsonSchemaForModel() },
      maxTokens: 8000,
    });

    promptTokens += completion.promptTokens;
    completionTokens += completion.completionTokens;
    model = completion.model;

    try {
      const parsed = aiPatchSchema.safeParse(parseJsonObject(completion.content));
      if (!parsed.success) {
        lastErrors = zodIssues(parsed.error);
        throw new AppError('AI_INVALID_OUTPUT', 'Model output did not match the patch schema');
      }

      // Path/size policy is enforced before anything touches GitHub.
      validatePatchSet(parsed.data.files, tree);

      return {
        payload: parsed.data,
        model,
        promptTokens,
        completionTokens,
      };
    } catch (error) {
      const issues =
        isAppError(error) && error.code === 'PATCH_REJECTED'
          ? [`policy: ${error.message}`]
          : lastErrors;
      lastErrors = issues;
      log.warn('agent.rejected_output', { provider: provider.id, attempt, issues });

      if (attempt === 1) break;
      conversation.push({ role: 'assistant', content: completion.content.slice(0, 4000) });
      conversation.push({ role: 'user', content: buildRepairPrompt(issues) });
    }
  }

  throw new AppError('AI_INVALID_OUTPUT', `Model output rejected: ${lastErrors.join('; ')}`, {
    meta: { provider: provider.id, issues: lastErrors },
  });
}

export async function generatePatch(
  env: Env,
  input: { prompt: string; context: RepoContext; tree: TreeEntryLike[] },
): Promise<GeneratedPatch> {
  const config = loadConfig(env);
  const providers = providersFor(config);

  if (providers.length === 0) {
    throw new AppError('CONFIG_ERROR', 'No AI provider is configured', { status: 503 });
  }

  const messages: AiMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt({ prompt: input.prompt, context: input.context }) },
  ];

  const failures: string[] = [];
  let sawUnavailable = false;

  for (const provider of providers) {
    try {
      const outcome = await runProvider(provider, config, messages, input.tree);
      const validated = validatePatchSet(outcome.payload.files, input.tree);

      return {
        summary: outcome.payload.summary,
        files: validated.map((file) => ({
          path: file.path,
          operation: file.operation,
          content: file.content,
          baseBlobSha: file.baseBlobSha,
          ...(file.reason ? { reason: file.reason } : {}),
        })),
        model: outcome.model,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
      };
    } catch (error) {
      const appError = isAppError(error)
        ? error
        : new AppError('AI_UNAVAILABLE', 'AI call failed', { cause: error });
      failures.push(`${provider.id}: ${appError.message}`);
      if (appError.code === 'AI_UNAVAILABLE') sawUnavailable = true;
      log.error('agent.provider_failed', {
        provider: provider.id,
        code: appError.code,
        message: appError.message,
      });
    }
  }

  throw new AppError(
    sawUnavailable ? 'AI_UNAVAILABLE' : 'AI_INVALID_OUTPUT',
    sawUnavailable
      ? 'The coding model is unavailable right now'
      : 'The coding model could not produce a valid change set',
    { retryable: sawUnavailable, meta: { failures: failures.slice(0, 3) } },
  );
}
