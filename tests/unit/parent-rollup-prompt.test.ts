import { describe, it, expect } from 'vitest';
import {
  buildParentRollupPrompt,
  buildRollupReducePrompt,
} from '../../src/prompts/parent-rollup';

describe('buildRollupReducePrompt', () => {
  const sampleChunks = ['chunk summary A', 'chunk summary B'];
  const parentUri = 'viking://resources/docs/';

  it('returns a string', () => {
    const result = buildRollupReducePrompt(sampleChunks, parentUri);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('contains the abstract and sections schema keys', () => {
    const result = buildRollupReducePrompt(sampleChunks, parentUri);
    expect(result).toContain('abstract');
    expect(result).toContain('sections');
  });

  it('forbids duplicate content across chunks', () => {
    const result = buildRollupReducePrompt(sampleChunks, parentUri);
    // Accept either "duplicate" or "do not repeat"
    const hasAntiDup = /duplicate|do not repeat/i.test(result);
    expect(hasAntiDup).toBe(true);
  });

  it('mentions the parent URI when passed in', () => {
    const result = buildRollupReducePrompt(sampleChunks, parentUri);
    expect(result).toContain(parentUri);
  });

  it('instructs max 120 tokens for the abstract', () => {
    const result = buildRollupReducePrompt(sampleChunks, parentUri);
    expect(result).toContain('120');
  });

  it('throws when chunkSummaries is empty', () => {
    expect(() => buildRollupReducePrompt([], parentUri)).toThrow(
      'buildRollupReducePrompt: chunkSummaries must not be empty'
    );
  });
});

describe('buildParentRollupPrompt (regression)', () => {
  it('remains exported and returns a non-empty prompt', () => {
    const result = buildParentRollupPrompt();
    expect(typeof result).toBe('string');
    expect(result).toContain('abstract');
  });
});
