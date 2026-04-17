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

import { summariseSession } from '../../src/services/bedrock';

describe('bedrock session services', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('summariseSession', () => {
    it('calls Bedrock with session summary prompt and returns SessionSummary', async () => {
      const mockResult = {
        one_line: 'Discussed authentication patterns',
        analysis: 'User explored JWT and OAuth approaches',
        key_concepts: ['JWT', 'OAuth', 'refresh tokens'],
        pending_tasks: ['implement login page'],
      };

      mockSend.mockResolvedValueOnce({
        output: {
          message: { content: [{ text: JSON.stringify(mockResult) }] },
        },
      });

      const result = await summariseSession('User: How does JWT work?\nAssistant: JWT is...');
      expect(result.one_line).toBe('Discussed authentication patterns');
      expect(result.key_concepts).toEqual(['JWT', 'OAuth', 'refresh tokens']);
      expect(result.pending_tasks).toEqual(['implement login page']);
    });

    it('strips code blocks before parsing', async () => {
      const mockResult = {
        one_line: 'Test',
        analysis: 'Test analysis',
        key_concepts: ['a'],
        pending_tasks: [],
      };

      mockSend.mockResolvedValueOnce({
        output: {
          message: { content: [{ text: '```json\n' + JSON.stringify(mockResult) + '\n```' }] },
        },
      });

      const result = await summariseSession('messages');
      expect(result.one_line).toBe('Test');
    });
  });
});
