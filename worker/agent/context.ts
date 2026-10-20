import type { TreeEntry } from '../github/repo';

/**
 * Cheap, deterministic context selection. We never dump a whole repo into the
 * prompt: that is slow, expensive, and mostly irrelevant for a single task.
 */

export const CONTEXT_LIMITS = {
  maxFiles: 20,
  maxFilesListed: 400,
  maxFileChars: 24_000,
  maxTotalChars: 90_000,
} as const;

const IGNORED_PREFIXES = [
  'node_modules/',
  'dist/',
  'build/',
  '.git/',
  '.next/',
  '.wrangler/',
  'vendor/',
  'coverage/',
  'public/assets/',
] as const;

const IGNORED_FILES = [
  /^package-lock\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^bun\.lockb?$/,
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|mp4|mp3|pdf|zip|wasm)$/i,
] as const;

const HIGH_VALUE_FILES = [
  'readme.md',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'wrangler.jsonc',
  'wrangler.toml',
  'index.html',
  'src/main.tsx',
  'src/app.tsx',
  'src/index.ts',
  'src/index.tsx',
  'app/page.tsx',
  'app/layout.tsx',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
] as const;

export function isContextEligible(entry: TreeEntry, maxBytes: number): boolean {
  const lower = entry.path.toLowerCase();
  if (IGNORED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  if (IGNORED_FILES.some((pattern) => pattern.test(entry.path))) return false;
  if (entry.size > maxBytes) return false;
  return true;
}

function keywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    .slice(0, 40);
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'make',
  'please',
  'should',
  'would',
  'could',
  'when',
  'then',
  'add',
  'use',
  'using',
  'want',
  'need',
  'change',
  'update',
  'remove',
  'file',
  'page',
  'code',
]);

/** Ranks files so the most likely edit targets land inside the budget. */
export function scoreEntry(path: string, words: string[]): number {
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop() ?? lower;
  let score = 0;

  if ((HIGH_VALUE_FILES as readonly string[]).includes(lower)) score += 60;
  if (lower.startsWith('src/') || lower.startsWith('app/')) score += 12;

  for (const word of words) {
    if (basename === word) score += 45;
    else if (basename.includes(word)) score += 14;
    if (lower.includes(word)) score += 6;
  }

  // Prefer shallow, small files when scores tie.
  score -= lower.split('/').length * 2;
  return score;
}

export interface SelectedContext {
  entries: TreeEntry[];
  omitted: number;
}

export function selectContextFiles(tree: TreeEntry[], prompt: string): SelectedContext {
  const words = keywords(prompt);
  const candidates = tree.filter((entry) => isContextEligible(entry, 256 * 1024));

  const ranked = candidates
    .map((entry) => ({ entry, score: scoreEntry(entry.path, words) }))
    .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));

  const picked: TreeEntry[] = [];
  let totalChars = 0;

  for (const candidate of ranked) {
    if (picked.length >= CONTEXT_LIMITS.maxFiles) break;
    const estimatedChars = Math.min(candidate.entry.size, CONTEXT_LIMITS.maxFileChars);
    if (totalChars + estimatedChars > CONTEXT_LIMITS.maxTotalChars) continue;
    picked.push(candidate.entry);
    totalChars += estimatedChars;
  }

  return {
    entries: picked.sort((a, b) => a.path.localeCompare(b.path)),
    omitted: Math.max(0, candidates.length - picked.length),
  };
}

export function truncateFileContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= CONTEXT_LIMITS.maxFileChars) {
    return { content, truncated: false };
  }
  return {
    content: `${content.slice(0, CONTEXT_LIMITS.maxFileChars)}\n\n... [file truncated by OpenMi]`,
    truncated: true,
  };
}
