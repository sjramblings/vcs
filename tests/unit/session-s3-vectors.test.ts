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
  function MockGetVectorsCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    S3VectorsClient: MockS3VectorsClient,
    PutVectorsCommand: MockPutVectorsCommand,
    DeleteVectorsCommand: MockDeleteVectorsCommand,
    QueryVectorsCommand: MockQueryVectorsCommand,
    GetVectorsCommand: MockGetVectorsCommand,
  };
});

import { initS3Vectors, getVectors } from '../../src/services/s3-vectors';

describe('s3-vectors session services', () => {
  beforeEach(() => {
    mockSend.mockReset();
    initS3Vectors('test-vector-bucket', 'test-index');
  });

  describe('getVectors', () => {
    it('retrieves vector data by keys', async () => {
      const embedding = new Array(1024).fill(0.1);
      mockSend.mockResolvedValueOnce({
        vectors: [
          {
            key: 'viking://resources/doc.md',
            data: { float32: embedding },
            metadata: { uri: 'viking://resources/doc.md', context_type: 'resource' },
          },
        ],
      });

      const result = await getVectors(['viking://resources/doc.md']);

      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('viking://resources/doc.md');
      expect(result[0].data).toEqual(embedding);
      expect(result[0].metadata.context_type).toBe('resource');

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.vectorBucketName).toBe('test-vector-bucket');
      expect(cmd.input.indexName).toBe('test-index');
      expect(cmd.input.keys).toEqual(['viking://resources/doc.md']);
    });
  });
});
