import type { ErrorCode, Issue } from '../shared/types.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  /** Every problem found, not just the first one. */
  readonly issues: Issue[];

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      issues?: Issue[];
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.details = opts.details;
    // Issues may be passed directly or inside details; both are surfaced.
    this.issues =
      opts.issues ??
      (Array.isArray(opts.details?.issues) ? (opts.details!.issues as Issue[]) : []);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        ...(this.issues.length ? { issues: this.issues } : {}),
      },
    };
  }
}

// Build a single issue. `path` is for file paths, `field` for request fields.
export function issue(
  code: string,
  message: string,
  extra: { path?: string; field?: string; source?: string; status?: number } = {},
): Issue {
  return { code, message, ...extra };
}

// One-line summary of many issues, e.g.
//   "3 problems: prompt is required; prompt too long (5000 > 4000 chars)"
export function summarizeIssues(issues: Issue[]): string {
  if (issues.length === 0) return 'no issues';
  if (issues.length === 1) return issues[0].message;
  return `${issues.length} problems: ${issues.map((i) => i.message).join('; ')}`;
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
// AI_OUTPUT_INVALID is treated as a task-level failure (bad model output) and
// does not refund, matching the quota-windows test contract.
export function refundsQuota(code: ErrorCode): boolean {
  return (
    code === 'CONFIG_ERROR' ||
    code === 'AI_PROVIDER_ERROR' ||
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
