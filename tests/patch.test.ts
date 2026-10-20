import { describe, expect, it } from 'vitest';
import {
  PATCH_LIMITS,
  assertNoDestructiveChange,
  assertSafePath,
  validatePatchSet,
} from '../worker/agent/patch';
import { AppError } from '../worker/lib/errors';

const tree = [
  { path: 'src/App.tsx', sha: 'sha-app', size: 120 },
  { path: 'src/main.tsx', sha: 'sha-main', size: 80 },
  { path: 'package.json', sha: 'sha-pkg', size: 400 },
];

function expectRejected(run: () => unknown, pattern?: RegExp) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PATCH_REJECTED');
    if (pattern) expect((error as AppError).message).toMatch(pattern);
    return;
  }
  throw new Error('Expected the patch to be rejected');
}

describe('assertSafePath', () => {
  it('accepts normal repo-relative paths', () => {
    expect(assertSafePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
    expect(assertSafePath('README.md')).toBe('README.md');
  });

  it('rejects traversal, absolute paths, and backslashes', () => {
    expectRejected(() => assertSafePath('../secrets.txt'), /traversal/i);
    expectRejected(() => assertSafePath('src/../../etc/passwd'), /traversal/i);
    expectRejected(() => assertSafePath('/etc/passwd'), /Absolute/i);
    expectRejected(() => assertSafePath('src\\App.tsx'), /Backslash/i);
    expectRejected(() => assertSafePath('src//App.tsx'), /empty segment/i);
    expectRejected(() => assertSafePath('src/'), /Directory/i);
  });

  it('rejects protected and secret-bearing paths', () => {
    expectRejected(() => assertSafePath('.github/workflows/deploy.yml'), /Protected/i);
    expectRejected(() => assertSafePath('node_modules/left-pad/index.js'), /Protected/i);
    expectRejected(() => assertSafePath('.env.local'), /Secret/i);
    expectRejected(() => assertSafePath('certs/server.pem'), /Secret/i);
    expectRejected(() => assertSafePath('id_rsa'), /Secret/i);
  });

  it('rejects binary targets', () => {
    expectRejected(() => assertSafePath('public/logo.png'), /Binary/i);
    expectRejected(() => assertSafePath('assets/font.woff2'), /Binary/i);
  });
});

describe('validatePatchSet', () => {
  it('resolves operations against the real tree and keeps base blob shas', () => {
    const result = validatePatchSet(
      [
        { path: 'src/App.tsx', operation: 'create', content: 'export const x = 1;\n' },
        { path: 'src/new.ts', operation: 'update', content: 'export const y = 2;\n', reason: 'add' },
      ],
      tree,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      path: 'src/App.tsx',
      operation: 'update',
      baseBlobSha: 'sha-app',
    });
    expect(result[1]).toMatchObject({
      path: 'src/new.ts',
      operation: 'create',
      baseBlobSha: null,
    });
    expect(result[1]?.reason).toBe('add');
  });

  it('rejects empty, oversized, and duplicate patches', () => {
    expectRejected(() => validatePatchSet([], tree), /did not propose/i);
    expectRejected(
      () =>
        validatePatchSet(
          [
            { path: 'src/a.ts', operation: 'create', content: 'a' },
            { path: 'src/a.ts', operation: 'update', content: 'b' },
          ],
          tree,
        ),
      /Duplicate/i,
    );
    expectRejected(
      () =>
        validatePatchSet(
          [
            {
              path: 'src/big.ts',
              operation: 'create',
              content: 'x'.repeat(PATCH_LIMITS.maxFileBytes + 1),
            },
          ],
          tree,
        ),
      /too large/i,
    );
  });

  it('rejects more files than one task may change', () => {
    const files = Array.from({ length: PATCH_LIMITS.maxFiles + 1 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      operation: 'create' as const,
      content: `export const v${index} = ${index};\n`,
    }));
    expectRejected(() => validatePatchSet(files, tree), /Too many files/i);
  });

  it('refuses to truncate an existing file to nothing', () => {
    expectRejected(
      () => validatePatchSet([{ path: 'src/App.tsx', operation: 'update', content: '   \n' }], tree),
      /empty an existing file/i,
    );
  });

  it('allows creating a new empty-ish file that has no existing counterpart', () => {
    const result = validatePatchSet(
      [{ path: 'src/empty.ts', operation: 'create', content: '\n' }],
      tree,
    );
    expect(result[0]?.operation).toBe('create');
  });

  it('rejects binary content smuggled through a text path', () => {
    expectRejected(
      () =>
        validatePatchSet(
          [{ path: 'src/binary.ts', operation: 'create', content: 'a\u0000b' }],
          tree,
        ),
      /Binary content/i,
    );
  });
});

describe('assertNoDestructiveChange', () => {
  it('passes when every base file survives', () => {
    expect(() =>
      assertNoDestructiveChange(['a.ts', 'b.ts'], ['a.ts', 'b.ts', 'c.ts']),
    ).not.toThrow();
  });

  it('blocks any commit that removes an existing file', () => {
    expect(() => assertNoDestructiveChange(['a.ts', 'b.ts'], ['a.ts'])).toThrow(AppError);
    try {
      assertNoDestructiveChange(['a.ts', 'b.ts'], ['a.ts']);
    } catch (error) {
      expect((error as AppError).code).toBe('PATCH_REJECTED');
      expect((error as AppError).message).toMatch(/would delete 1 existing file/i);
    }
  });
});
