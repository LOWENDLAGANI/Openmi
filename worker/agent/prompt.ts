import type { RepoContext } from '../workflows/types.js';
import { CONTEXT_LIMITS } from './context.js';

export const PATCH_SCHEMA_NAME = 'openmi_patch';

export function buildSystemPrompt(): string {
  return [
    'You are OpenMi, a senior full-stack engineer editing a user repository on their behalf.',
    'You work from a phone prompt, so the user has no terminal: your change must be complete and commit-ready.',
    '',
    'Output contract:',
    '- Reply with ONE JSON object and nothing else (no markdown fences, no prose).',
    '- Shape: {"summary": string, "files": [{"path": string, "operation": "create"|"update", "content": string, "reason": string}]}',
    '- `content` is the COMPLETE new file content, never a diff, patch, or elided snippet.',
    '- `summary` is 1-3 sentences describing what changed, in plain language for a non-engineer.',
    '- `reason` is one short sentence (max 20 words) explaining that file change.',
    '',
    'Hard rules:',
    '- You cannot delete files. Do not propose deletions, renames, or empty files.',
    '- Only touch files needed for the request. Prefer the smallest coherent change.',
    '- Never write `.github/**`, `.env*`, secrets, keys, lockfiles, or binary files.',
    '- Do not invent imports that are not already dependencies, unless the user explicitly asked for that dependency.',
    '- If the repo uses TypeScript, write strict, type-safe TypeScript. Match existing formatting and architecture.',
    '- For UI work, keep it mobile-first and accessible: semantic HTML, real tap targets, no hover-only affordances.',
    '- If the request is ambiguous, choose the most reasonable interpretation and state it in `summary`.',
    '',
    'You are one step in a durable pipeline. A separate system validates your paths and sizes,',
    'then commits your files atomically onto the branch with the untouched tree as its base.',
    'Anything that fails validation blocks the entire task.',
  ].join('\n');
}

export function buildUserPrompt(input: {
  prompt: string;
  context: RepoContext;
  maxTreePaths?: number;
}): string {
  const { context } = input;
  const maxTreePaths = input.maxTreePaths ?? CONTEXT_LIMITS.maxFilesListed;
  const listed = context.treePaths.slice(0, maxTreePaths);
  const treeNote =
    context.treePaths.length > listed.length
      ? `\n... ${context.treePaths.length - listed.length} more paths omitted`
      : '';

  const files = context.files
    .map(
      (file) =>
        `--- FILE: ${file.path}${file.truncated ? ' (truncated)' : ''}\n${file.content}\n--- END FILE`,
    )
    .join('\n\n');

  return [
    `Repository: ${context.snapshot.repoFullName}`,
    `Base branch: ${context.snapshot.branch} @ ${context.snapshot.baseSha.slice(0, 10)}`,
    `Files in repo: ${context.snapshot.fileCount}`,
    `Files omitted from context: ${context.omittedFiles}`,
    '',
    'File tree:',
    listed.join('\n') || '(empty repository)',
    treeNote,
    '',
    'Selected file contents:',
    files || '(no files provided)',
    '',
    `User request:\n${input.prompt}`,
    '',
    'Return the JSON object now.',
  ].join('\n');
}

export function buildRepairPrompt(errors: string[]): string {
  return [
    'Your previous reply was rejected by the validator.',
    'Problems:',
    ...errors.map((error) => `- ${error}`),
    '',
    'Return a corrected JSON object with the same contract. Do not explain, do not use markdown.',
  ].join('\n');
}
