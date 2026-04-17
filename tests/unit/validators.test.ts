import { describe, it, expect } from 'vitest';
import {
  lsRequestSchema,
  treeRequestSchema,
  readRequestSchema,
  mkdirRequestSchema,
} from '../../src/utils/validators';

describe('lsRequestSchema', () => {
  it('accepts valid directory URI', () => {
    const result = lsRequestSchema.safeParse({ uri: 'viking://resources/' });
    expect(result.success).toBe(true);
  });

  it('accepts with optional nextToken and limit', () => {
    const result = lsRequestSchema.safeParse({
      uri: 'viking://resources/',
      nextToken: 'abc',
      limit: 25,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid URI', () => {
    const result = lsRequestSchema.safeParse({ uri: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects non-directory URI (file)', () => {
    const result = lsRequestSchema.safeParse({ uri: 'viking://resources/file.md' });
    expect(result.success).toBe(false);
  });
});

describe('treeRequestSchema', () => {
  it('accepts valid directory URI with depth', () => {
    const result = treeRequestSchema.safeParse({
      uri: 'viking://resources/',
      depth: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects depth exceeding max of 10', () => {
    const result = treeRequestSchema.safeParse({
      uri: 'viking://resources/',
      depth: 11,
    });
    expect(result.success).toBe(false);
  });

  it('accepts without depth (uses default)', () => {
    const result = treeRequestSchema.safeParse({ uri: 'viking://resources/' });
    expect(result.success).toBe(true);
  });
});

describe('readRequestSchema', () => {
  it('accepts valid URI with level', () => {
    const result = readRequestSchema.safeParse({
      uri: 'viking://resources/file.md',
      level: 0,
    });
    expect(result.success).toBe(true);
  });

  it('accepts level 2 (max)', () => {
    const result = readRequestSchema.safeParse({
      uri: 'viking://resources/file.md',
      level: 2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects level 3 (exceeds max)', () => {
    const result = readRequestSchema.safeParse({
      uri: 'viking://resources/file.md',
      level: 3,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing level', () => {
    const result = readRequestSchema.safeParse({
      uri: 'viking://resources/file.md',
    });
    expect(result.success).toBe(false);
  });
});

describe('mkdirRequestSchema', () => {
  it('accepts valid directory URI', () => {
    const result = mkdirRequestSchema.safeParse({
      uri: 'viking://resources/new-dir/',
    });
    expect(result.success).toBe(true);
  });

  it('accepts with optional context_type', () => {
    const result = mkdirRequestSchema.safeParse({
      uri: 'viking://resources/new-dir/',
      context_type: 'resource',
    });
    expect(result.success).toBe(true);
  });

  it('rejects URI without trailing slash', () => {
    const result = mkdirRequestSchema.safeParse({
      uri: 'viking://resources/no-slash',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid context_type', () => {
    const result = mkdirRequestSchema.safeParse({
      uri: 'viking://resources/new-dir/',
      context_type: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});
