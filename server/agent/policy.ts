import type { PatchSet, PatchFile, Issue } from '../../shared/types.js';
import { AppError, issue, summarizeIssues } from '../errors.js';

export const MAX_FILES = 12;
export const MAX_FILE_BYTES = 256 * 1024;

const FORBIDDEN_PREFIXES = [
  '.github/',
  '.git/',
];
const FORBIDDEN_EXACT = new Set(['.env', '.env.local', '.env.production', '.env.development']);
const FORBIDDEN_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.cer'];

// Non-throwing path check: returns every rule the path breaks, so a model
// that violates several rules at once gets told about all of them.
export function checkSafePath(path: string): Issue[] {
  const issues: Issue[] = [];
  if (!path) {
    issues.push(issue('EMPTY_PATH', 'empty file path', { path }));
    return issues;
  }
  if (path.startsWith('/')) {
    issues.push(issue('ABSOLUTE_PATH', `absolute path forbidden: ${path}`, { path }));
  }
  if (path.includes('..')) {
    issues.push(issue('PATH_TRAVERSAL', `path traversal forbidden: ${path}`, { path }));
  }
  if (path.includes('\0')) {
    issues.push(issue('NULL_BYTE', 'null byte in path', { path }));
  }
  const norm = path.replace(/\\/g, '/');
  if (FORBIDDEN_PREFIXES.some((p) => norm.startsWith(p))) {
    issues.push(issue('FORBIDDEN_PATH', `path forbidden by policy: ${path}`, { path }));
  }
  const base = norm.split('/').pop()!;
  if (FORBIDDEN_EXACT.has(base) || base.startsWith('.env')) {
    issues.push(issue('SECRET_FILE', `env/secret file forbidden: ${path}`, { path }));
  }
  if (FORBIDDEN_SUFFIXES.some((s) => base.endsWith(s))) {
    issues.push(issue('KEY_FILE', `key/cert file forbidden: ${path}`, { path }));
  }
  return issues;
}

export function assertSafePath(path: string): void {
  const issues = checkSafePath(path);
  if (issues.length) {
    throw new AppError('AI_OUTPUT_INVALID', summarizeIssues(issues), {
      details: { issues },
    });
  }
}

// Validate a model-produced patch set against policy.
// - only create/update ops (deletions are not representable in the schema)
// - safe paths, size caps, file-count cap
// Every violation is collected, so a model that breaks five rules learns all
// five at once instead of one per attempt.
export function validatePatchSet(patch: PatchSet): void {
  if (!patch || !Array.isArray(patch.files)) {
    throw new AppError('AI_OUTPUT_INVALID', 'patch set missing files array');
  }
  const issues: Issue[] = [];
  if (patch.files.length === 0) {
    issues.push(issue('EMPTY_PATCH', 'patch set is empty'));
  }
  if (patch.files.length > MAX_FILES) {
    issues.push(
      issue('TOO_MANY_FILES', `too many files (${patch.files.length} > ${MAX_FILES})`),
    );
  }
  const seen = new Set<string>();
  for (const f of patch.files) {
    const path = typeof f?.path === 'string' ? f.path : '';
    if (f?.op !== 'create' && f?.op !== 'update') {
      issues.push(issue('ILLEGAL_OP', `illegal op: ${String(f?.op)}`, { path }));
    }
    issues.push(...checkSafePath(path));
    if (seen.has(path)) {
      issues.push(issue('DUPLICATE_PATH', `duplicate path: ${path}`, { path }));
    }
    seen.add(path);
    if (typeof f?.content !== 'string') {
      issues.push(issue('INVALID_CONTENT', `non-string content for ${path}`, { path }));
    } else if (Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) {
      issues.push(issue('FILE_TOO_LARGE', `file too large: ${path}`, { path }));
    }
  }
  if (issues.length) {
    throw new AppError('AI_OUTPUT_INVALID', summarizeIssues(issues), {
      details: { issues },
      retryable: false,
    });
  }
}

// Reconcile patch targets against the real tree.
// - update targets must exist and match the snapshot blob sha (else GITHUB_CONFLICT)
// - create targets must not exist
export interface TreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree';
  size?: number;
}

export function assertPatchTargets(
  patch: PatchSet,
  baseTree: TreeEntry[],
  snapshotShas: Map<string, string>,
): void {
  const byPath = new Map(baseTree.map((e) => [e.path, e]));
  const issues: Issue[] = [];
  for (const f of patch.files) {
    const existing = byPath.get(f.path);
    if (f.op === 'create') {
      if (existing) {
        issues.push(
          issue('CREATE_EXISTS', `model tried to create existing file: ${f.path}`, {
            path: f.path,
          }),
        );
      }
    } else {
      // update
      if (!existing) {
        issues.push(
          issue('UPDATE_MISSING', `model tried to update missing file: ${f.path}`, {
            path: f.path,
          }),
        );
        continue;
      }
      const expected = snapshotShas.get(f.path);
      if (expected && expected !== existing.sha) {
        issues.push(
          issue('FILE_CHANGED', `file changed during generation: ${f.path}`, {
            path: f.path,
          }),
        );
      }
    }
  }
  if (issues.length) {
    throw new AppError('GITHUB_CONFLICT', summarizeIssues(issues), {
      details: { issues },
    });
  }
}

// After building the new tree, assert it is a superset of the base tree.
export function assertSuperset(baseTree: TreeEntry[], newTree: TreeEntry[]): void {
  const newPaths = new Set(newTree.map((e) => e.path));
  for (const e of baseTree) {
    if (e.type === 'blob' && !newPaths.has(e.path)) {
      throw new AppError('INTERNAL', `base tree path missing from new tree: ${e.path}`);
    }
  }
}

export function patchSummary(patch: PatchSet): string {
  const creates = patch.files.filter((f) => f.op === 'create').length;
  const updates = patch.files.length - creates;
  return `${patch.files.length} file(s): ${creates} created, ${updates} updated — ${patch.summary ?? ''}`;
}
