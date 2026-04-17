import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock('@aws-sdk/client-s3vectors', () => {
  function MockS3VectorsClient() { (this as Record<string, unknown>).send = mockSend; }
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

import { initS3Vectors, putVector, deleteVector, awaitVectorVisibility, putVectorBatch } from '../../src/services/s3-vectors';
import type { VectorInput } from '../../src/services/s3-vectors';

function makeVectorInput(i: number): VectorInput {
  return {
    uri: `viking://resources/test/doc-${i}.md`,
    parentUri: 'viking://resources/test/',
    contextType: 'resource',
    level: 0,
    abstract: `Abstract for doc ${i}`,
    embedding: new Array(1024).fill(0.1),
  };
}

describe('s3-vectors service', () => {
  beforeEach(() => {
    mockSend.mockReset();
    initS3Vectors('test-vector-bucket', 'test-index');
  });

  describe('putVector', () => {
    it('sends PutVectorsCommand with correct metadata keys', async () => {
      const embedding = new Array(1024).fill(0.1);
      mockSend.mockResolvedValueOnce({});

      await putVector(
        'viking://resources/doc.md',
        'viking://resources/',
        'resource',
        0,
        'Test abstract',
        embedding
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentCommand = mockSend.mock.calls[0][0];
      const input = sentCommand.input;
      expect(input.vectorBucketName).toBe('test-vector-bucket');
      expect(input.indexName).toBe('test-index');
      expect(input.vectors).toHaveLength(1);

      const vector = input.vectors[0];
      expect(vector.key).toBe('viking://resources/doc.md');
      expect(vector.data.float32).toEqual(embedding);

      const meta = vector.metadata;
      expect(meta.uri).toBe('viking://resources/doc.md');
      expect(meta.parent_uri).toBe('viking://resources/');
      expect(meta.context_type).toBe('resource');
      expect(meta.level).toBe(0);
      expect(meta.abstract).toBe('Test abstract');
      expect(meta.created_at).toBeDefined();
    });
  });

  describe('deleteVector', () => {
    it('sends DeleteVectorsCommand with correct key', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteVector('viking://resources/doc.md');

      const sentCommand = mockSend.mock.calls[0][0];
      const input = sentCommand.input;
      expect(input.vectorBucketName).toBe('test-vector-bucket');
      expect(input.indexName).toBe('test-index');
      expect(input.keys).toEqual(['viking://resources/doc.md']);
    });
  });

  describe('awaitVectorVisibility', () => {
    const testUri = 'viking://resources/test/doc.md';
    const testEmbedding = new Array(1024).fill(0.1);

    it('returns { visible: true, attempts: 1 } when vector is immediately searchable', async () => {
      mockSend.mockResolvedValueOnce({
        vectors: [{ key: testUri, distance: 0.0, metadata: {} }],
      });

      const result = await awaitVectorVisibility(testUri, testEmbedding, 5, 1);
      expect(result).toEqual({ visible: true, attempts: 1 });
    });

    it('returns { visible: true, attempts: 3 } after delayed convergence', async () => {
      // First two queries return empty, third returns the vector
      mockSend
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce({ vectors: [] })
        .mockResolvedValueOnce({ vectors: [{ key: testUri, distance: 0.0, metadata: {} }] });

      const result = await awaitVectorVisibility(testUri, testEmbedding, 5, 1);
      expect(result).toEqual({ visible: true, attempts: 3 });
    });

    it('returns { visible: false, attempts: 3 } after max attempts — does NOT throw', async () => {
      mockSend.mockResolvedValue({ vectors: [] });

      const result = await awaitVectorVisibility(testUri, testEmbedding, 3, 1);
      expect(result).toEqual({ visible: false, attempts: 3 });
    });
  });

  describe('putVectorBatch', () => {
    it('writes multiple vectors in a single API call for batches <= 25', async () => {
      mockSend.mockResolvedValueOnce({});
      const vectors = Array.from({ length: 10 }, (_, i) => makeVectorInput(i));

      const result = await putVectorBatch(vectors);

      expect(result).toEqual({ succeeded: 10, failed: [] });
      expect(mockSend).toHaveBeenCalledTimes(1);
      const sentCommand = mockSend.mock.calls[0][0];
      const input = sentCommand.input;
      expect(input.vectors).toHaveLength(10);
      expect(input.vectorBucketName).toBe('test-vector-bucket');
      expect(input.indexName).toBe('test-index');
    });

    it('splits into multiple API calls for batches > 25', async () => {
      mockSend.mockResolvedValue({});
      const vectors = Array.from({ length: 60 }, (_, i) => makeVectorInput(i));

      const result = await putVectorBatch(vectors);

      expect(result).toEqual({ succeeded: 60, failed: [] });
      expect(mockSend).toHaveBeenCalledTimes(3);
      expect(mockSend.mock.calls[0][0].input.vectors).toHaveLength(25);
      expect(mockSend.mock.calls[1][0].input.vectors).toHaveLength(25);
      expect(mockSend.mock.calls[2][0].input.vectors).toHaveLength(10);
    });

    it('no-ops on empty array', async () => {
      const result = await putVectorBatch([]);

      expect(result).toEqual({ succeeded: 0, failed: [] });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('continues through batch failures and reports which items failed', async () => {
      mockSend
        .mockResolvedValueOnce({})                              // batch 1 succeeds
        .mockRejectedValueOnce(new Error('Capacity exceeded'))  // batch 2 fails
        .mockResolvedValueOnce({});                             // batch 3 succeeds
      const vectors = Array.from({ length: 60 }, (_, i) => makeVectorInput(i));

      const result = await putVectorBatch(vectors);

      expect(result.succeeded).toBe(35); // 25 + 10
      expect(result.failed).toHaveLength(25);
      expect(result.failed[0].error).toBe('Capacity exceeded');
      expect(result.failed[0].uri).toBe('viking://resources/test/doc-25.md');
    });
  });
});
