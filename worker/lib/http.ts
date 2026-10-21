import type { Context } from 'hono';
import type { z } from 'zod';
import { AppError } from './errors.js';

/**
 * Parses and validates a JSON request body.
 * Returns a typed value or throws `VALIDATION_FAILED` with field-level detail.
 */
export async function readJson<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Request body must be valid JSON');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new AppError('VALIDATION_FAILED', detail || 'Invalid request body');
  }

  return parsed.data;
}
