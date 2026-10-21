import type { PatchSet, PatchFile } from '../../shared/types.js';
import { AppError } from '../errors.js';

export const MAX_FILES = 12;
export const MAX_FILE_BYTES = 256 * 1024;

const FORBIDDEN_PREFIXES = [
  '.github/',
  '.git/',
];
const FORBIDDEN_EXACT = new Set(['.env', '.env.local', '.env.production', '.env.development']);
const FORBIDDEN_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.cer'];

export function assertSafePath(path: string): void {
  if (!path) throw new AppError('AI_OUTPUT_INVALID', 'empty file path');
  if (path.startsWith('/')) throw new AppError('AI_OUTPUT_INVALID', `absolute path forbidden: ${path}`);
  if (path.includes('..')) throw new AppError('AI_OUTPUT_INVALID', `path traversal forbidden: ${path}`);
  if (path.includes('\0')) throw new AppError('AI_OUTPUT_INVALID', 'null byte in path');
  const norm = path.replace(/\\/g, '/');
  if (FORBIDDEN_PREFIXES.some((p) => norm.startsWith(p))) {
    throw new AppError('AI_OUTPUT_INVALID', `path forbidden by policy: ${path}`);
  }
  const base = norm.split('/').pop()!;
  if (FORBIDDEN_EXACT.has(base) || base.startsWith('.env')) {
    throw new AppError('AI_OUTPUT_INVALID', `env/secret file forbidden: ${path}`);
  }
  if (FORBIDDEN_SUFFIXES.some((s) => base.endsWith(s))) {
    throw new AppError('AI_OUTPUT_INVALID', `key/cert file forbidden: ${path}`);
  }
}

// Validate a model-produced patch set against policy.
// - only create/update ops (deletions are not representable in the schema)
// - safe paths, size caps, file-count cap
export function validatePatchSet(patch: PatchSet): void {
  if (!patch || !Array.isArray(patch.files)) {
    throw new AppError('AI_OUTPUT_INVALID', 'patch set missing files array');
  }
  if (patch.files.length === 0) {
    throw new AppError('AI_OUTPUT_INVALID', 'patch set is empty');
  }
  if (patch.files.length > MAX_FILES) {
    throw new AppError('AI_OUTPUT_INVALID', `too many files (${patch.files.length} > ${MAX_FILES})`);
  }
  const seen = new Set<string>();
  for (const f of patch.files) {
    if (f.op !== 'create' && f.op !== 'update') {
      throw new AppError('AI_OUTPUT_INVALID', `illegal op: ${f.op}`);
    }
    assertSafePath(f.path);
    if (seen.has(f.path)) {
      throw new AppError('AI_OUTPUT_INVALID', `duplicate path: ${f.path}`);
    }
    seen.add(f.path);
    if (typeof f.content !== 'string') {
      throw new AppError('AI_OUTPUT_INVALID', `non-string content for ${f.path}`);
    }
    if (Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) {
      throw new AppError('AI_OUTPUT_INVALID', `file too large: ${f.path}`);
    }
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
  for (const f of patch.files) {
    const existing = byPath.get(f.path);
    if (f.op === 'create') {
      if (existing) {
        throw new AppError('GITHUB_CONFLICT', `model tried to create existing file: ${f.path}`);
      }
    } else {
      // update
      if (!existing) {
        throw new AppError('GITHUB_CONFLICT', `model tried to update missing file: ${f.path}`);
      }
      const expected = snapshotShas.get(f.path);
      if (expected && expected !== existing.sha) {
        throw new AppError('GITHUB_CONFLICT', `file changed during generation: ${f.path}`);
      }
    }
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
