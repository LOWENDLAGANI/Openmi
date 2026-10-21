import type { Octokit } from '@octokit/rest';
import type { TreeEntry } from './policy.js';

export const MAX_CONTEXT_FILES = 20;
export const MAX_CONTEXT_BYTES = 64 * 1024;

const PRIORITY_PATTERNS = [
  /^README/i,
  /package\.json$/,
  /tsconfig\.json$/,
  /vite\.config/,
  /^src\//,
  /^server\//,
  /^app\//,
  /\.tsx?$/,
  /\.jsx?$/,
  /\.py$/,
  /\.go$/,
  /\.rs$/,
];

// Deterministic, bounded repo context. No embeddings at this phase.
export async function selectContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  tree: TreeEntry[],
  prompt: string,
): Promise<Array<{ path: string; content: string }>> {
  const promptLower = prompt.toLowerCase();
  const scored = tree
    .filter((e) => e.type === 'blob')
    .map((e) => {
      let score = 0;
      const pathLower = e.path.toLowerCase();
      if (promptLower.includes(pathLower.split('/').pop() ?? '')) score += 10;
      for (const p of PRIORITY_PATTERNS) if (p.test(e.path)) score += 2;
      // Penalise huge files and non-source.
      if ((e.size ?? 0) > 32 * 1024) score -= 5;
      if (/\.(png|jpg|jpeg|gif|lock|map|min\.js)$/i.test(e.path)) score -= 10;
      return { entry: e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const out: Array<{ path: string; content: string }> = [];
  let bytes = 0;
  for (const { entry } of scored) {
    if (out.length >= MAX_CONTEXT_FILES) break;
    if (bytes >= MAX_CONTEXT_BYTES) break;
    try {
      const { data } = await octokit.git.getBlob({ owner, repo, file_sha: entry.sha });
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      const size = Buffer.byteLength(content, 'utf8');
      if (bytes + size > MAX_CONTEXT_BYTES) continue;
      out.push({ path: entry.path, content });
      bytes += size;
    } catch {
      // skip unreadable blobs (binaries etc.)
    }
  }
  return out;
}

export function formatContext(files: Array<{ path: string; content: string }>): string {
  return files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');
}
