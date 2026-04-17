import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock('@aws-sdk/client-dynamodb', () => {
  function MockDynamoDBClient() { (this as Record<string, unknown>).send = mockSend; }
  return { DynamoDBClient: MockDynamoDBClient };
});

vi.mock('@aws-sdk/lib-dynamodb', () => {
  function MockDocClient() { (this as Record<string, unknown>).send = mockSend; }
  MockDocClient.from = () => new MockDocClient();
  function MockQueryCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockGetCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockPutCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockUpdateCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockDeleteCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockBatchWriteCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    DynamoDBDocumentClient: MockDocClient,
    QueryCommand: MockQueryCommand,
    GetCommand: MockGetCommand,
    PutCommand: MockPutCommand,
    UpdateCommand: MockUpdateCommand,
    DeleteCommand: MockDeleteCommand,
    BatchWriteCommand: MockBatchWriteCommand,
  };
});

import {
  initDynamoDB,
  initSessionsDB,
  putSessionEntry,
  getSessionMeta,
  getAllSessionMessages,
  updateSessionStatus,
  incrementActiveCount,
  batchDeleteItems,
  deleteItem,
} from '../../src/services/dynamodb';

describe('dynamodb session services', () => {
  beforeEach(() => {
    mockSend.mockReset();
    initDynamoDB('test-context-table');
    initSessionsDB('test-sessions-table');
  });

  describe('putSessionEntry', () => {
    it('writes to sessions table with correct PK/SK', async () => {
      mockSend.mockResolvedValueOnce({});

      await putSessionEntry({
        session_id: 'sess-1',
        entry_type_seq: 'msg#001',
        role: 'user',
        parts: [{ type: 'text' as const, content: 'Hello' }],
        timestamp: '2026-01-01T00:00:00Z',
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.TableName).toBe('test-sessions-table');
      expect(cmd.input.Item.session_id).toBe('sess-1');
      expect(cmd.input.Item.entry_type_seq).toBe('msg#001');
    });
  });

  describe('getSessionMeta', () => {
    it('reads meta#0 and returns SessionEntry', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          session_id: 'sess-1',
          entry_type_seq: 'meta#0',
          status: 'active',
          timestamp: '2026-01-01T00:00:00Z',
        },
      });

      const result = await getSessionMeta('sess-1');
      expect(result).not.toBeNull();
      expect(result!.session_id).toBe('sess-1');
      expect(result!.entry_type_seq).toBe('meta#0');

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.Key.session_id).toBe('sess-1');
      expect(cmd.input.Key.entry_type_seq).toBe('meta#0');
    });

    it('returns null when meta#0 not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });
      const result = await getSessionMeta('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getAllSessionMessages', () => {
    it('queries all msg# entries with ScanIndexForward true', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [
          { session_id: 'sess-1', entry_type_seq: 'msg#001', role: 'user', timestamp: '2026-01-01T00:00:00Z' },
          { session_id: 'sess-1', entry_type_seq: 'msg#002', role: 'assistant', timestamp: '2026-01-01T00:00:01Z' },
        ],
        LastEvaluatedKey: undefined,
      });

      const result = await getAllSessionMessages('sess-1');
      expect(result).toHaveLength(2);
      expect(result[0].entry_type_seq).toBe('msg#001');

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.KeyConditionExpression).toContain('begins_with');
      expect(cmd.input.ScanIndexForward).toBe(true);
    });

    it('paginates until all items retrieved', async () => {
      mockSend
        .mockResolvedValueOnce({
          Items: [{ session_id: 'sess-1', entry_type_seq: 'msg#001', timestamp: '2026-01-01T00:00:00Z' }],
          LastEvaluatedKey: { session_id: 'sess-1', entry_type_seq: 'msg#001' },
        })
        .mockResolvedValueOnce({
          Items: [{ session_id: 'sess-1', entry_type_seq: 'msg#002', timestamp: '2026-01-01T00:00:01Z' }],
          LastEvaluatedKey: undefined,
        });

      const result = await getAllSessionMessages('sess-1');
      expect(result).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateSessionStatus', () => {
    it('conditionally updates meta#0 status and returns true', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await updateSessionStatus('sess-1', 'committed');
      expect(result).toBe(true);

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.Key.session_id).toBe('sess-1');
      expect(cmd.input.Key.entry_type_seq).toBe('meta#0');
      expect(cmd.input.ConditionExpression).toContain('active');
    });

    it('returns false if already committed (ConditionalCheckFailedException)', async () => {
      const err = new Error('Condition not met');
      err.name = 'ConditionalCheckFailedException';
      mockSend.mockRejectedValueOnce(err);

      const result = await updateSessionStatus('sess-1', 'committed');
      expect(result).toBe(false);
    });
  });

  describe('incrementActiveCount', () => {
    it('uses ADD expression on context table', async () => {
      mockSend.mockResolvedValueOnce({});

      await incrementActiveCount('viking://resources/doc.md');

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.TableName).toBe('test-context-table');
      expect(cmd.input.UpdateExpression).toContain('ADD');
      expect(cmd.input.UpdateExpression).toContain('active_count');
    });
  });

  describe('batchDeleteItems', () => {
    it('handles batches of 25', async () => {
      // Create 30 items to test batching
      const keys = Array.from({ length: 30 }, (_, i) => ({
        uri: `viking://resources/item-${i}`,
        level: 0,
      }));

      mockSend
        .mockResolvedValueOnce({ UnprocessedItems: undefined })
        .mockResolvedValueOnce({ UnprocessedItems: undefined });

      await batchDeleteItems(keys);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('retries UnprocessedItems with backoff', async () => {
      const keys = [{ uri: 'viking://resources/item-1', level: 0 }];

      mockSend
        .mockResolvedValueOnce({
          UnprocessedItems: {
            'test-context-table': [
              { DeleteRequest: { Key: { uri: 'viking://resources/item-1', level: 0 } } },
            ],
          },
        })
        .mockResolvedValueOnce({ UnprocessedItems: undefined });

      await batchDeleteItems(keys);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleteItem', () => {
    it('deletes from context table', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteItem('viking://resources/doc.md', 0);

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.TableName).toBe('test-context-table');
      expect(cmd.input.Key.uri).toBe('viking://resources/doc.md');
      expect(cmd.input.Key.level).toBe(0);
    });
  });
});
