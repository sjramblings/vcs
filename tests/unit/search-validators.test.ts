import { describe, it, expect } from 'vitest';
import {
  findRequestSchema,
  searchRequestSchema,
} from '../../src/utils/validators';

describe('findRequestSchema', () => {
  it('accepts valid find request with all fields', () => {
    const result = findRequestSchema.safeParse({
      query: 'test',
      scope: 'viking://resources/',
      max_results: 5,
      min_score: 0.2,
    });
    expect(result.success).toBe(true);
  });

  it('defaults max_results to 5 and min_score to 0.2 when omitted', () => {
    const result = findRequestSchema.safeParse({ query: 'test' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_results).toBe(5);
      expect(result.data.min_score).toBe(0.2);
    }
  });

  it('rejects empty query', () => {
    const result = findRequestSchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid scope URI', () => {
    const result = findRequestSchema.safeParse({
      query: 'test',
      scope: 'invalid-uri',
    });
    expect(result.success).toBe(false);
  });

  it('rejects max_results > 20', () => {
    const result = findRequestSchema.safeParse({
      query: 'test',
      max_results: 21,
    });
    expect(result.success).toBe(false);
  });

  it('rejects min_score > 1', () => {
    const result = findRequestSchema.safeParse({
      query: 'test',
      min_score: 1.1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts scope as optional', () => {
    const result = findRequestSchema.safeParse({ query: 'test query' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scope).toBeUndefined();
    }
  });
});

describe('searchRequestSchema', () => {
  it('accepts valid search request with all fields', () => {
    const result = searchRequestSchema.safeParse({
      query: 'test',
      session_id: 'sess_abc',
      max_results: 5,
      min_score: 0.2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing session_id', () => {
    const result = searchRequestSchema.safeParse({ query: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects empty query', () => {
    const result = searchRequestSchema.safeParse({
      query: '',
      session_id: 'sess_abc',
    });
    expect(result.success).toBe(false);
  });

  it('defaults max_results to 5 and min_score to 0.2 when omitted', () => {
    const result = searchRequestSchema.safeParse({
      query: 'test',
      session_id: 'sess_abc',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_results).toBe(5);
      expect(result.data.min_score).toBe(0.2);
    }
  });
});
