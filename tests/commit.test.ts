import { describe, expect, it } from 'vitest';
import { assertPatchTargets, describeCommitPlan } from '../worker/github/commit';
import type { PatchFile } from '../worker/workflows/types';

const tree = [
  { path: 'src/App.tsx', sha: 'sha-app', size: 100 },
  { path: 'src/util.ts', sha: 'sha-util', size: 50 },
];

function patch(overrides: Partial<PatchFile> & Pick<PatchFile, 'path' | 'operation'>): PatchFile {
  return {
    content: 'export const value = 1;\n',
    baseBlobSha: null,
    ...overrides,
  };
}

describe('assertPatchTargets', () => {
  it('accepts updates whose base blob is unchanged', () => {
    const result = assertPatchTargets(
      [patch({ path: 'src/App.tsx', operation: 'update', baseBlobSha: 'sha-app' })],
      tree,
    );
    expect(result.overwrites).toEqual([]);
  });

  it('aborts when a human changed the same file after the snapshot', () => {
    expect(() =>
      assertPatchTargets(
        [patch({ path: 'src/App.tsx', operation: 'update', baseBlobSha: 'stale-sha' })],
        tree,
      ),
    ).toThrowError(/changed on GitHub/);
  });

  it('aborts when an update target vanished', () => {
    expect(() =>
      assertPatchTargets([patch({ path: 'src/deleted.ts', operation: 'update' })], tree),
    ).toThrowError(/no longer exists/);
  });

  it('flags create targets that already exist instead of silently ignoring them', () => {
    const result = assertPatchTargets([patch({ path: 'src/util.ts', operation: 'create' })], tree);
    expect(result.overwrites).toEqual(['src/util.ts']);
  });

  it('reports AppError codes so the workflow can classify failures', () => {
    try {
      assertPatchTargets([patch({ path: 'src/gone.ts', operation: 'update' })], tree);
      throw new Error('expected throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('GITHUB_CONFLICT');
    }
  });
});

describe('describeCommitPlan', () => {
  it('describes one atomic commit for all files', () => {
    const plan = describeCommitPlan({
      files: [
        patch({ path: 'src/App.tsx', operation: 'update' }),
        patch({ path: 'src/new.ts', operation: 'create' }),
      ],
      branch: 'main',
      mode: 'direct',
    });

    expect(plan).toEqual({
      paths: ['src/App.tsx', 'src/new.ts'],
      branch: 'main',
      mode: 'direct',
      atomic: true,
    });
  });
});
