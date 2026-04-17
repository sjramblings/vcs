import { describe, it, expect } from 'vitest';
import { parseUri, validateUri, validateDirectoryUri, getParentUri, isDirectoryUri } from '../../src/utils/uri';

describe('parseUri', () => {
  it('parses a directory URI with segments', () => {
    const result = parseUri('viking://resources/docs/auth/');
    expect(result).toEqual({
      raw: 'viking://resources/docs/auth/',
      scope: 'resources',
      segments: ['docs', 'auth'],
      isDirectory: true,
      depth: 3,
      parentUri: 'viking://resources/docs/',
    });
  });

  it('parses a file URI with segments', () => {
    const result = parseUri('viking://user/memories/profile/coding-style');
    expect(result).toEqual({
      raw: 'viking://user/memories/profile/coding-style',
      scope: 'user',
      segments: ['memories', 'profile', 'coding-style'],
      isDirectory: false,
      depth: 4,
      parentUri: 'viking://user/memories/profile/',
    });
  });

  it('parses a scope-root directory URI', () => {
    const result = parseUri('viking://resources/');
    expect(result).toEqual({
      raw: 'viking://resources/',
      scope: 'resources',
      segments: [],
      isDirectory: true,
      depth: 1,
      parentUri: 'viking://',
    });
  });
});

describe('validateUri', () => {
  it('accepts valid directory URIs', () => {
    expect(validateUri('viking://resources/').success).toBe(true);
    expect(validateUri('viking://user/memories/').success).toBe(true);
    expect(validateUri('viking://session/abc-123/').success).toBe(true);
  });

  it('accepts valid file URIs', () => {
    expect(validateUri('viking://agent/skills/code-search').success).toBe(true);
  });

  it('accepts URIs with hyphens and numbers', () => {
    expect(validateUri('viking://resources/a-hyphenated-name/').success).toBe(true);
    expect(validateUri('viking://resources/abc123/').success).toBe(true);
  });

  it('rejects empty string', () => {
    const result = validateUri('');
    expect(result.success).toBe(false);
  });

  it('rejects wrong protocol', () => {
    const result = validateUri('http://example.com');
    expect(result.success).toBe(false);
  });

  it('rejects invalid scope', () => {
    const result = validateUri('viking://invalid-scope/');
    expect(result.success).toBe(false);
  });

  it('rejects double slashes in path', () => {
    const result = validateUri('viking://resources//double/');
    expect(result.success).toBe(false);
  });

  it('rejects uppercase URIs', () => {
    const result = validateUri('VIKING://RESOURCES/');
    expect(result.success).toBe(false);
  });

  it('rejects URIs with spaces', () => {
    const result = validateUri('viking://resources/has spaces/');
    expect(result.success).toBe(false);
  });

  it('rejects URIs exceeding max depth of 10', () => {
    const result = validateUri('viking://resources/a/b/c/d/e/f/g/h/i/j/k/');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/depth/i);
    }
  });
});

describe('validateDirectoryUri', () => {
  it('accepts URIs ending with /', () => {
    const result = validateDirectoryUri('viking://resources/docs/');
    expect(result.success).toBe(true);
  });

  it('rejects URIs without trailing slash', () => {
    const result = validateDirectoryUri('viking://resources/docs');
    expect(result.success).toBe(false);
  });

  it('rejects file URIs without trailing slash', () => {
    const result = validateDirectoryUri('viking://resources/file.md');
    expect(result.success).toBe(false);
  });
});

describe('getParentUri', () => {
  it('returns parent for nested directory', () => {
    expect(getParentUri('viking://resources/docs/auth/')).toBe('viking://resources/docs/');
  });

  it('returns parent for scope-level directory', () => {
    expect(getParentUri('viking://resources/docs/')).toBe('viking://resources/');
  });

  it('returns root for scope root directory', () => {
    expect(getParentUri('viking://resources/')).toBe('viking://');
  });

  it('returns parent directory for file URI', () => {
    expect(getParentUri('viking://resources/file.md')).toBe('viking://resources/');
  });

  it('returns null for root URI', () => {
    expect(getParentUri('viking://')).toBeNull();
  });
});

describe('isDirectoryUri', () => {
  it('returns true for directory URIs', () => {
    expect(isDirectoryUri('viking://resources/')).toBe(true);
  });

  it('returns false for file URIs', () => {
    expect(isDirectoryUri('viking://resources/file.md')).toBe(false);
  });
});
