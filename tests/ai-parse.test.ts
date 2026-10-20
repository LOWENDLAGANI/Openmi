import { describe, expect, it } from 'vitest';
import { aiPatchSchema, parseJsonObject } from '../worker/agent/generate';
import { todayUtc } from '../worker/lib/time';

describe('parseJsonObject', () => {
  it('parses plain JSON', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced JSON', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('salvages JSON wrapped in chatter', () => {
    expect(parseJsonObject('Sure! Here you go: {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  it('throws a typed error on garbage', () => {
    expect(() => parseJsonObject('not json at all')).toThrowError(/not valid JSON/);
  });
});

describe('aiPatchSchema', () => {
  it('accepts a well-formed patch payload', () => {
    const result = aiPatchSchema.safeParse({
      summary: 'Adds a button.',
      files: [{ path: 'src/App.tsx', operation: 'update', content: 'x' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown operations and empty file lists', () => {
    expect(
      aiPatchSchema.safeParse({
        summary: 'x',
        files: [{ path: 'a.ts', operation: 'delete', content: '' }],
      }).success,
    ).toBe(false);

    expect(aiPatchSchema.safeParse({ summary: 'x', files: [] }).success).toBe(false);
  });
});

describe('quota window helpers', () => {
  it('formats the UTC day used as the quota key', () => {
    expect(todayUtc(new Date('2026-10-20T23:59:59Z'))).toBe('2026-10-20');
    expect(todayUtc(new Date('2026-10-21T00:00:01Z'))).toBe('2026-10-21');
  });
});
