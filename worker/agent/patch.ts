import { AppError } from '../lib/errors';

/**
 * The safety core of OpenMi.
 *
 * Model output is never trusted: every proposed file path is checked against a
 * strict policy, every operation is reconciled against the actual repo tree,
 * and only "create" / "update" survive. Deletions are not representable, and
 * any change that would remove an existing file is rejected here long before
 * a commit exists.
 */

export const PATCH_LIMITS = {
  maxFiles: 12,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxPathLength: 200,
} as const;

/**
 * `.github/**` is blocked on purpose: letting a prompt rewrite CI workflows
 * would give arbitrary code execution on the user's repository runners.
 */
const FORBIDDEN_PREFIXES = [
  '.git/',
  '.github/',
  'node_modules/',
  'dist/',
  '.wrangler/',
  'vendor/',
  'coverage/',
] as const;

const FORBIDDEN_FILE_PATTERNS = [
  /^\.env(\.|$)/i,
  /^\.dev\.vars/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /^id_(rsa|ed25519|ecdsa)/i,
  /^\.npmrc$/i,
] as const;

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tar',
  'tgz',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'mov',
  'webm',
  'wasm',
  'so',
  'dylib',
  'exe',
  'dll',
  'bin',
  'lockb',
  'sqlite',
  'db',
]);

export interface ProposedFile {
  path: string;
  operation: 'create' | 'update';
  content: string;
  reason?: string;
}

export interface TreeEntryLike {
  path: string;
  sha: string;
  size?: number;
}

export interface ValidatedFile {
  path: string;
  operation: 'create' | 'update';
  content: string;
  /** Blob sha of the file at the task's base commit (null for creates). */
  baseBlobSha: string | null;
  bytes: number;
  reason?: string;
}

function reject(message: string): never {
  throw new AppError('PATCH_REJECTED', message);
}

const utf8 = new TextEncoder();

export function byteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

/** Validates a single repo-relative path. Throws `PATCH_REJECTED`. */
export function assertSafePath(rawPath: string): string {
  const path = rawPath.trim();

  if (path.length === 0) reject('Patch contains an empty file path');
  if (path.length > PATCH_LIMITS.maxPathLength) reject(`File path is too long: ${path.slice(0, 80)}`);
  if (path.startsWith('/') || path.startsWith('~')) reject(`Absolute paths are not allowed: ${path}`);
  if (path.includes('\\')) reject(`Backslashes are not allowed in paths: ${path}`);
  if (/[\u0000-\u001f\u007f]/.test(path)) reject('File path contains control characters');
  if (path.endsWith('/')) reject(`Directory paths are not editable: ${path}`);

  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    reject(`File path has an empty segment: ${path}`);
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    reject(`Path traversal is not allowed: ${path}`);
  }

  const lower = path.toLowerCase();
  if (FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    reject(`Protected path cannot be modified by the agent: ${path}`);
  }
  if (FORBIDDEN_FILE_PATTERNS.some((pattern) => pattern.test(path))) {
    reject(`Secret-bearing file cannot be modified by the agent: ${path}`);
  }

  const extension = lower.includes('.') ? (lower.split('.').pop() ?? '') : '';
  if (BINARY_EXTENSIONS.has(extension)) {
    reject(`Binary files cannot be generated: ${path}`);
  }

  return path;
}

/**
 * Reconciles model-proposed files with the real tree:
 * - unknown paths become `create`, existing paths become `update`;
 * - update targets keep their base blob sha so later steps can detect that a
 *   human changed the file while the agent was thinking;
 * - duplicate and oversized entries are rejected outright.
 */
export function validatePatchSet(
  proposed: ProposedFile[],
  tree: TreeEntryLike[],
  options: { maxFiles?: number } = {},
): ValidatedFile[] {
  const maxFiles = options.maxFiles ?? PATCH_LIMITS.maxFiles;

  if (proposed.length === 0) reject('The agent did not propose any file changes');
  if (proposed.length > maxFiles) {
    reject(`Too many files in one task (${proposed.length} > ${maxFiles})`);
  }

  const treeByPath = new Map(tree.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const validated: ValidatedFile[] = [];
  let totalBytes = 0;

  for (const file of proposed) {
    const path = assertSafePath(file.path);
    if (seen.has(path)) reject(`Duplicate path in patch: ${path}`);
    seen.add(path);

    if (typeof file.content !== 'string') reject(`Missing content for ${path}`);
    if (file.content.includes('\u0000')) reject(`Binary content is not allowed: ${path}`);

    const bytes = byteLength(file.content);
    if (bytes > PATCH_LIMITS.maxFileBytes) {
      reject(`File too large: ${path} (${bytes} bytes)`);
    }
    totalBytes += bytes;
    if (totalBytes > PATCH_LIMITS.maxTotalBytes) {
      reject('Patch set is too large for a single task');
    }

    const existing = treeByPath.get(path);
    const operation: 'create' | 'update' = existing ? 'update' : 'create';

    // Destructive-truncation guard: never let a task blank out a real file.
    if (existing && (existing.size ?? 0) > 0 && file.content.trim().length === 0) {
      reject(`Refusing to empty an existing file: ${path}`);
    }

    validated.push({
      path,
      operation,
      content: file.content,
      baseBlobSha: existing?.sha ?? null,
      bytes,
      ...(file.reason ? { reason: file.reason.slice(0, 300) } : {}),
    });
  }

  return validated;
}

/**
 * Asserts the new tree still contains every file the base tree had.
 * Used as a pre-commit invariant on the GitHub side.
 */
export function assertNoDestructiveChange(
  basePaths: Iterable<string>,
  newPaths: Iterable<string>,
): void {
  const next = new Set(newPaths);
  const missing: string[] = [];
  for (const path of basePaths) {
    if (!next.has(path)) missing.push(path);
  }
  if (missing.length > 0) {
    throw new AppError(
      'PATCH_REJECTED',
      `Commit blocked: it would delete ${missing.length} existing file(s)`,
      { meta: { sample: missing.slice(0, 5) } },
    );
  }
}
