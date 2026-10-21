import type { ErrorCode } from '../shared/types.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.details = opts.details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'QUOTA_EXCEEDED':
    case 'TOO_MANY_RUNNING_TASKS':
      return 429;
    case 'GITHUB_NOT_CONNECTED':
      return 409;
    case 'GITHUB_CONFLICT':
      return 409;
    case 'INVALID_INPUT':
      return 400;
    case 'GITHUB_AUTH_EXPIRED':
      return 401;
    case 'CONFIG_ERROR':
      return 500;
    case 'AI_PROVIDER_ERROR':
    case 'AI_OUTPUT_INVALID':
      return 502;
    case 'GITHUB_UNAVAILABLE':
      return 502;
    case 'GITHUB_NOT_FOUND':
      return 404;
    case 'INTERNAL':
    default:
      return 500;
  }
}

// Failures that are "ours" — the system, not the user or a race — refund quota.
export function refundsQuota(code: ErrorCode): boolean {
  return (
    code === 'CONFIG_ERROR' ||
    code === 'AI_PROVIDER_ERROR' ||
    code === 'AI_OUTPUT_INVALID' ||
    code === 'GITHUB_AUTH_EXPIRED' ||
    code === 'GITHUB_UNAVAILABLE' ||
    code === 'INTERNAL'
  );
}

function defaultRetryable(code: ErrorCode): boolean {
  return (
    code === 'AI_PROVIDER_ERROR' ||
    code === 'GITHUB_UNAVAILABLE' ||
    code === 'INTERNAL'
  );
}

export class DeadlineExceededError extends Error {
  constructor() {
    super('runner budget exhausted; handing off to a fresh invocation');
    this.name = 'DeadlineExceededError';
  }
}
