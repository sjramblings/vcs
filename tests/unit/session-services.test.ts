import { describe, it, expect } from 'vitest';

// ── Task 1: Types, prompts, and validators ──

describe('memory types', () => {
  it('SessionSummary has one_line, analysis, key_concepts, pending_tasks', async () => {
    const mod = await import('../../src/types/memory');
    const summary: import('../../src/types/memory').SessionSummary = {
      one_line: 'User discussed auth patterns',
      analysis: 'Detailed analysis of auth',
      key_concepts: ['JWT', 'OAuth'],
      pending_tasks: ['implement login'],
    };
    expect(summary.one_line).toBe('User discussed auth patterns');
    expect(summary.key_concepts).toEqual(['JWT', 'OAuth']);
    expect(summary.pending_tasks).toEqual(['implement login']);
  });
});

describe('session/filesystem validators', () => {
  it('createSessionSchema validates empty body', async () => {
    const { createSessionSchema } = await import('../../src/utils/validators');
    const result = createSessionSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('addMessageSchema validates role and parts', async () => {
    const { addMessageSchema } = await import('../../src/utils/validators');

    const valid = addMessageSchema.safeParse({
      role: 'user',
      parts: [{ type: 'text', content: 'Hello' }],
    });
    expect(valid.success).toBe(true);

    // context part
    const contextPart = addMessageSchema.safeParse({
      role: 'assistant',
      parts: [{ type: 'context', uri: 'viking://resources/doc.md', abstract: 'A doc' }],
    });
    expect(contextPart.success).toBe(true);

    // tool part
    const toolPart = addMessageSchema.safeParse({
      role: 'tool',
      parts: [{ type: 'tool', name: 'search', input: {}, output: {}, success: true }],
    });
    expect(toolPart.success).toBe(true);

    // invalid role
    const invalidRole = addMessageSchema.safeParse({
      role: 'invalid',
      parts: [{ type: 'text', content: 'Hello' }],
    });
    expect(invalidRole.success).toBe(false);

    // missing parts
    const noParts = addMessageSchema.safeParse({ role: 'user' });
    expect(noParts.success).toBe(false);
  });

  it('usedSchema validates uris array with optional skill', async () => {
    const { usedSchema } = await import('../../src/utils/validators');

    const valid = usedSchema.safeParse({ uris: ['viking://resources/doc.md'] });
    expect(valid.success).toBe(true);

    const withSkill = usedSchema.safeParse({
      uris: ['viking://resources/doc.md'],
      skill: 'search',
    });
    expect(withSkill.success).toBe(true);

    // empty uris array
    const emptyUris = usedSchema.safeParse({ uris: [] });
    expect(emptyUris.success).toBe(false);
  });

  it('rmRequestSchema validates uri with viking:// URI', async () => {
    const { rmRequestSchema } = await import('../../src/utils/validators');

    const valid = rmRequestSchema.safeParse({ uri: 'viking://resources/doc.md' });
    expect(valid.success).toBe(true);

    const invalid = rmRequestSchema.safeParse({ uri: 'not-a-uri' });
    expect(invalid.success).toBe(false);
  });

  it('mvRequestSchema validates from_uri and to_uri both valid URIs', async () => {
    const { mvRequestSchema } = await import('../../src/utils/validators');

    const valid = mvRequestSchema.safeParse({
      from_uri: 'viking://resources/old/',
      to_uri: 'viking://resources/new/',
    });
    expect(valid.success).toBe(true);

    const invalidFrom = mvRequestSchema.safeParse({
      from_uri: 'bad-uri',
      to_uri: 'viking://resources/new/',
    });
    expect(invalidFrom.success).toBe(false);
  });
});

describe('prompt builders', () => {
  it('buildSessionSummaryPrompt returns a string', async () => {
    const { buildSessionSummaryPrompt } = await import('../../src/prompts/session-summary');
    const prompt = buildSessionSummaryPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('one_line');
    expect(prompt).toContain('key_concepts');
  });

});
