import { describe, expect, it } from 'vitest';
import {
  CONTEXT_LIMITS,
  isContextEligible,
  scoreEntry,
  selectContextFiles,
  truncateFileContent,
} from '../worker/agent/context';
import type { TreeEntry } from '../worker/github/repo';

function entry(path: string, size = 500): TreeEntry {
  return { path, sha: `sha-${path}`, size };
}

describe('isContextEligible', () => {
  it('filters vendored, generated, lock, and binary files', () => {
    expect(isContextEligible(entry('node_modules/react/index.js'), 1000)).toBe(false);
    expect(isContextEligible(entry('dist/bundle.js'), 1000)).toBe(false);
    expect(isContextEligible(entry('package-lock.json'), 1000)).toBe(false);
    expect(isContextEligible(entry('assets/hero.png'), 1000)).toBe(false);
    expect(isContextEligible(entry('src/App.tsx'), 1000)).toBe(true);
  });

  it('skips files above the per-file ceiling', () => {
    expect(isContextEligible(entry('src/huge.ts', 300 * 1024), 200 * 1024)).toBe(false);
  });
});

describe('scoreEntry', () => {
  it('ranks a file named in the prompt above an unrelated one', () => {
    const words = ['button', 'header'];
    expect(scoreEntry('src/components/Button.tsx', words)).toBeGreaterThan(
      scoreEntry('src/lib/db.ts', words),
    );
  });

  it('favours well-known entry points', () => {
    expect(scoreEntry('readme.md', [])).toBeGreaterThan(scoreEntry('scripts/tool.ts', []));
  });
});

describe('selectContextFiles', () => {
  it('keeps the relevant file when the budget is tight', () => {
    const tree = [
      entry('src/lib/analytics.ts'),
      entry('src/components/SettingsPanel.tsx'),
      entry('docs/architecture.md'),
      ...Array.from({ length: 60 }, (_, index) => entry(`src/modules/module-${index}.ts`)),
    ];

    const selection = selectContextFiles(tree, 'make the settings panel mobile friendly');
    const paths = selection.entries.map((item) => item.path);

    expect(paths).toContain('src/components/SettingsPanel.tsx');
    expect(selection.entries.length).toBeLessThanOrEqual(CONTEXT_LIMITS.maxFiles);
    expect(selection.omitted).toBeGreaterThan(0);
  });

  it('never exceeds the total character budget', () => {
    const tree = Array.from({ length: 40 }, (_, index) =>
      entry(`src/feature-${index}.ts`, CONTEXT_LIMITS.maxFileChars),
    );
    const selection = selectContextFiles(tree, 'refactor everything');

    expect(selection.entries.length).toBeLessThan(CONTEXT_LIMITS.maxFiles);
    expect(selection.entries.length * CONTEXT_LIMITS.maxFileChars).toBeLessThanOrEqual(
      CONTEXT_LIMITS.maxTotalChars,
    );
  });

  it('returns deterministic ordering for the same input', () => {
    const tree = [entry('src/b.ts'), entry('src/a.ts'), entry('src/c.ts')];
    const first = selectContextFiles(tree, 'update the app').entries.map((item) => item.path);
    const second = selectContextFiles(tree, 'update the app').entries.map((item) => item.path);
    expect(first).toEqual(second);
  });
});

describe('truncateFileContent', () => {
  it('leaves small files alone and marks large ones', () => {
    expect(truncateFileContent('small')).toEqual({ content: 'small', truncated: false });
    const big = 'x'.repeat(CONTEXT_LIMITS.maxFileChars + 10);
    const result = truncateFileContent(big);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('truncated by OpenMi');
  });
});
