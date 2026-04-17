import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks for all three SDK clients
const { mockS3VectorsSend, mockDynamoSend, mockBedrockSend } = vi.hoisted(() => {
  const mockS3VectorsSend = vi.fn();
  const mockDynamoSend = vi.fn();
  const mockBedrockSend = vi.fn();
  return { mockS3VectorsSend, mockDynamoSend, mockBedrockSend };
});

vi.mock('@aws-sdk/client-s3vectors', () => {
  function MockS3VectorsClient() { (this as Record<string, unknown>).send = mockS3VectorsSend; }
  function MockPutVectorsCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockDeleteVectorsCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockQueryVectorsCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    S3VectorsClient: MockS3VectorsClient,
    PutVectorsCommand: MockPutVectorsCommand,
    DeleteVectorsCommand: MockDeleteVectorsCommand,
    QueryVectorsCommand: MockQueryVectorsCommand,
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  function MockDynamoDBClient() {}
  return { DynamoDBClient: MockDynamoDBClient };
});

vi.mock('@aws-sdk/lib-dynamodb', () => {
  function MockGetCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockQueryCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockPutCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockUpdateCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    DynamoDBDocumentClient: {
      from: () => ({ send: mockDynamoSend }),
    },
    GetCommand: MockGetCommand,
    QueryCommand: MockQueryCommand,
    PutCommand: MockPutCommand,
    UpdateCommand: MockUpdateCommand,
  };
});

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  function MockClient() { (this as Record<string, unknown>).send = mockBedrockSend; }
  function MockConverseCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockInvokeModelCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    BedrockRuntimeClient: MockClient,
    ConverseCommand: MockConverseCommand,
    InvokeModelCommand: MockInvokeModelCommand,
  };
});

import { initS3Vectors, queryVectors } from '../../src/services/s3-vectors';
import { initSessionsDB, getSessionContext } from '../../src/services/dynamodb';
import { analyseIntent } from '../../src/services/bedrock';
import { buildIntentAnalysisPrompt } from '../../src/prompts/intent-analysis';

describe('queryVectors', () => {
  beforeEach(() => {
    mockS3VectorsSend.mockReset();
    initS3Vectors('test-bucket', 'test-index');
  });

  it('returns mapped results from QueryVectorsCommand', async () => {
    mockS3VectorsSend.mockResolvedValueOnce({
      vectors: [
        {
          key: 'viking://resources/doc.md',
          distance: 0.3,
          metadata: { uri: 'viking://resources/doc.md', context_type: 'resource', abstract: 'Test doc' },
        },
        {
          key: 'viking://resources/other.md',
          distance: 0.5,
          metadata: { uri: 'viking://resources/other.md', context_type: 'resource', abstract: 'Other doc' },
        },
      ],
    });

    const results = await queryVectors([0.1, 0.2, 0.3], 10);

    expect(results).toHaveLength(2);
    expect(results[0].key).toBe('viking://resources/doc.md');
    expect(results[0].distance).toBe(0.3);
    expect(results[0].metadata.abstract).toBe('Test doc');

    const sentCommand = mockS3VectorsSend.mock.calls[0][0];
    expect(sentCommand.input.topK).toBe(10);
    expect(sentCommand.input.returnMetadata).toBe(true);
    expect(sentCommand.input.returnDistance).toBe(true);
  });

  it('returns empty array when no vectors', async () => {
    mockS3VectorsSend.mockResolvedValueOnce({ vectors: null });

    const results = await queryVectors([0.1, 0.2], 5);
    expect(results).toEqual([]);
  });

  it('passes filter parameter when provided', async () => {
    mockS3VectorsSend.mockResolvedValueOnce({ vectors: [] });

    await queryVectors([0.1], 5, { context_type: { $eq: 'memory' } });

    const sentCommand = mockS3VectorsSend.mock.calls[0][0];
    expect(sentCommand.input.filter).toEqual({ context_type: { $eq: 'memory' } });
  });

  it('omits filter when undefined', async () => {
    mockS3VectorsSend.mockResolvedValueOnce({ vectors: [] });

    await queryVectors([0.1], 5);

    const sentCommand = mockS3VectorsSend.mock.calls[0][0];
    expect(sentCommand.input.filter).toBeUndefined();
  });
});

describe('getSessionContext', () => {
  beforeEach(() => {
    mockDynamoSend.mockReset();
    initSessionsDB('test-sessions-table');
  });

  it('returns summary and messages when session exists', async () => {
    // First call: GetCommand for meta#0
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        session_id: 'sess_123',
        entry_type_seq: 'meta#0',
        compression_summary: 'User prefers dark mode',
      },
    });
    // Second call: QueryCommand for messages
    mockDynamoSend.mockResolvedValueOnce({
      Items: [
        { session_id: 'sess_123', entry_type_seq: 'msg#005', role: 'user', content: 'Hello' },
        { session_id: 'sess_123', entry_type_seq: 'msg#004', role: 'assistant', content: 'Hi there' },
      ],
    });

    const result = await getSessionContext('sess_123');
    expect(result.summary).toBe('User prefers dark mode');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toBe('Hello');
  });

  it('throws NotFoundError when meta#0 not found', async () => {
    mockDynamoSend.mockResolvedValueOnce({ Item: undefined });

    await expect(getSessionContext('nonexistent')).rejects.toThrow('Session not found');
  });
});

describe('analyseIntent', () => {
  beforeEach(() => {
    mockBedrockSend.mockReset();
  });

  it('returns parsed sub-queries from Bedrock response', async () => {
    const intentResult = {
      queries: [
        { query: 'deployment guide', context_type: 'resource', intent: 'find deployment docs', priority: 1 },
        { query: 'user preferences for deploy', context_type: 'memory', intent: 'user deploy prefs', priority: 3 },
      ],
    };

    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{ text: JSON.stringify(intentResult) }],
        },
      },
    });

    const result = await analyseIntent('How do I deploy?', 'User is working on deployment', []);
    expect(result.queries).toHaveLength(2);
    expect(result.queries[0].query).toBe('deployment guide');
    expect(result.queries[0].context_type).toBe('resource');
    expect(result.queries[0].priority).toBe(1);
  });

  it('returns empty queries array for chitchat response', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      output: {
        message: {
          content: [{ text: JSON.stringify({ queries: [] }) }],
        },
      },
    });

    const result = await analyseIntent('Hello!', '', []);
    expect(result.queries).toEqual([]);
  });
});

describe('buildIntentAnalysisPrompt', () => {
  it('returns a system prompt string', () => {
    const prompt = buildIntentAnalysisPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('resource');
    expect(prompt).toContain('memory');
    expect(prompt).toContain('skill');
  });
});
