export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'SETUP_REQUIRED'
  | 'CONFIG_ERROR'
  | 'CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'TOO_MANY_RUNNING_TASKS'
  | 'GITHUB_NOT_CONNECTED'
  | 'GITHUB_AUTH_EXPIRED'
  | 'GITHUB_FORBIDDEN'
  | 'GITHUB_NOT_FOUND'
  | 'GITHUB_CONFLICT'
  | 'GITHUB_UNAVAILABLE'
  | 'AI_UNAVAILABLE'
  | 'AI_INVALID_OUTPUT'
  | 'PATCH_REJECTED'
  | 'INTERNAL';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SETUP_REQUIRED: 428,
  CONFIG_ERROR: 503,
  CONFLICT: 409,
  QUOTA_EXCEEDED: 429,
  TOO_MANY_RUNNING_TASKS: 429,
  GITHUB_NOT_CONNECTED: 409,
  GITHUB_AUTH_EXPIRED: 401,
  GITHUB_FORBIDDEN: 403,
  GITHUB_NOT_FOUND: 404,
  GITHUB_CONFLICT: 409,
  GITHUB_UNAVAILABLE: 502,
  AI_UNAVAILABLE: 502,
  AI_INVALID_OUTPUT: 502,
  PATCH_REJECTED: 422,
  INTERNAL: 500,
};

/**
 * Errors that justify refunding the user's daily task quota: the failure was
 * ours (config, provider, bad model output), not the user's.
 */
export const REFUNDABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'CONFIG_ERROR',
  'AI_UNAVAILABLE',
  'AI_INVALID_OUTPUT',
  'GITHUB_AUTH_EXPIRED',
  'GITHUB_UNAVAILABLE',
  'INTERNAL',
]);

export interface AppErrorOptions {
  status?: number;
  retryable?: boolean;
  cause?: unknown;
  /** Safe for clients: small, structured, no secrets. */
  meta?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly meta: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.retryable = options.retryable ?? false;
    this.meta = options.meta ?? {};
  }

  toWire(requestId?: string): {
    error: { code: string; message: string; requestId?: string };
  } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError('INTERNAL', message || 'Unexpected error', { cause: error });
}
