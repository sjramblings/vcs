import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  function MockClient() { (this as Record<string, unknown>).send = mockSend; }
  function MockConverseCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockInvokeModelCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    BedrockRuntimeClient: MockClient,
    ConverseCommand: MockConverseCommand,
    InvokeModelCommand: MockInvokeModelCommand,
  };
});

import { summariseDocument, summariseParent, generateEmbedding, computeBackoff, estimateTokens, selectModelForContent } from '../../src/services/bedrock';

describe('bedrock service', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('summariseDocument', () => {
    it('returns valid SummarisationResult from Haiku response', async () => {
      const mockResult = {
        abstract: 'Test abstract about key recommendations',
        sections: [{ title: 'Section 1', summary: 'Summary of section 1' }],
      };

      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [{ text: JSON.stringify(mockResult) }],
          },
        },
      });

      const result = await summariseDocument('Some document content');
      expect(result).toEqual(mockResult);
      expect(result.abstract).toBe('Test abstract about key recommendations');
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].title).toBe('Section 1');
    });

    it('strips markdown code blocks before parsing', async () => {
      const mockResult = {
        abstract: 'Stripped abstract',
        sections: [{ title: 'S1', summary: 'Sum1' }],
      };

      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [{ text: '```json\n' + JSON.stringify(mockResult) + '\n```' }],
          },
        },
      });

      const result = await summariseDocument('Content');
      expect(result.abstract).toBe('Stripped abstract');
    });

    it('throws on invalid JSON response', async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [{ text: 'This is not JSON at all' }],
          },
        },
      });

      await expect(summariseDocument('Content')).rejects.toThrow();
    });

    it('throws on empty Bedrock response', async () => {
      mockSend.mockResolvedValueOnce({
        output: { message: { content: [] } },
      });

      await expect(summariseDocument('Content')).rejects.toThrow();
    });

    it('validates response schema with Zod (rejects missing fields)', async () => {
      mockSend.mockResolvedValueOnce({
        output: {
          message: {
            content: [{ text: JSON.stringify({ abstract: 'Only abstract, no sections' }) }],
          },
        },
      });

      await expect(summariseDocument('Content')).rejects.toThrow();
    });

    it('uses ConverseCommand with correct model and parameters', async () => {
      const mockResult = {
        abstract: 'Test',
        sections: [{ title: 'T', summary: 'S' }],
      };

      mockSend.mockResolvedValueOnce({
        output: {
          message: { content: [{ text: JSON.stringify(mockResult) }] },
        },
      });

      await summariseDocument('Content', 'Focus on security');

      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.modelId).toBe('amazon.nova-lite-v1:0');
      expect(sentCommand.input.inferenceConfig.maxTokens).toBe(4096);
      expect(sentCommand.input.inferenceConfig.temperature).toBe(0);
    });
  });

  describe('summariseParent', () => {
    it('uses parent rollup prompt and returns SummarisationResult', async () => {
      const mockResult = {
        abstract: 'Parent directory synthesis',
        sections: [{ title: 'Theme A', summary: 'Grouped synthesis' }],
      };

      mockSend.mockResolvedValueOnce({
        output: {
          message: { content: [{ text: JSON.stringify(mockResult) }] },
        },
      });

      const result = await summariseParent('- child1: abstract1\n- child2: abstract2');
      expect(result.abstract).toBe('Parent directory synthesis');
      expect(result.sections).toHaveLength(1);
    });
  });

  describe('retry configuration', () => {
    it('computeBackoff(1) returns value in range [500, 1500]', () => {
      const delay = computeBackoff(1);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1500);
    });

    it('computeBackoff(2) returns value in range [1000, 2000]', () => {
      const delay = computeBackoff(2);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    });

    it('computeBackoff(7) returns value in range [30000, 31000] (capped at 30s + jitter)', () => {
      const delay = computeBackoff(7);
      expect(delay).toBeGreaterThanOrEqual(30000);
      expect(delay).toBeLessThanOrEqual(31000);
    });

    it('computeBackoff(8) is also capped at 30s + jitter', () => {
      const delay = computeBackoff(8);
      expect(delay).toBeGreaterThanOrEqual(30000);
      expect(delay).toBeLessThanOrEqual(31000);
    });
  });

  describe('generateEmbedding', () => {
    it('returns 1024-dimension array from Titan response', async () => {
      const embedding = new Array(1024).fill(0.1);
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(JSON.stringify({ embedding })),
      });

      const result = await generateEmbedding('Some text to embed');
      expect(result).toHaveLength(1024);
      expect(result[0]).toBe(0.1);
    });

    it('uses InvokeModelCommand with correct Titan model and params', async () => {
      const embedding = new Array(1024).fill(0.5);
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(JSON.stringify({ embedding })),
      });

      await generateEmbedding('Text');

      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.modelId).toBe('amazon.titan-embed-text-v2:0');
      expect(sentCommand.input.contentType).toBe('application/json');
      expect(sentCommand.input.accept).toBe('application/json');

      const body = JSON.parse(sentCommand.input.body);
      expect(body.dimensions).toBe(1024);
      expect(body.normalize).toBe(true);
    });
  });

  describe('estimateTokens', () => {
    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('returns Math.ceil(5/3.5) = 2 for "hello"', () => {
      expect(estimateTokens('hello')).toBe(2);
    });

    it('returns ~114286 for 400000-character string', () => {
      const longString = 'a'.repeat(400_000);
      expect(estimateTokens(longString)).toBe(Math.ceil(400_000 / 3.5));
    });
  });

  describe('selectModelForContent', () => {
    it('returns preferred model when content is within token limit', () => {
      // 100_000 chars = ~28571 tokens — well within Nova Lite 270K limit
      const result = selectModelForContent('amazon.nova-lite-v1:0', 100_000);
      expect(result).toBe('amazon.nova-lite-v1:0');
    });

    it('accepts large content up to Nova Lite 270K token ceiling', () => {
      // 800_000 chars = ~228,571 tokens — within Nova Lite 270K limit
      const result = selectModelForContent('amazon.nova-lite-v1:0', 800_000);
      expect(result).toBe('amazon.nova-lite-v1:0');
    });

    it('throws "Content too large" when content exceeds Nova Lite 270K ceiling', () => {
      // 1_000_000 chars = ~285,714 tokens — exceeds Nova Lite 270K limit
      expect(() => selectModelForContent('amazon.nova-lite-v1:0', 1_000_000)).toThrow('Content too large');
    });

    it('uses 115K default limit for unknown model IDs', () => {
      const withinLimit = selectModelForContent('unknown.model-v1:0', 100_000);
      expect(withinLimit).toBe('unknown.model-v1:0');

      // 500_000 chars = ~142K tokens — exceeds 115K default for unknown models
      expect(() => selectModelForContent('unknown.model-v1:0', 500_000)).toThrow('Content too large');
    });
  });
});
