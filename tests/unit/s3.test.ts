import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock('@aws-sdk/client-s3', () => {
  function MockS3Client() { (this as Record<string, unknown>).send = mockSend; }
  function MockPutObjectCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockGetObjectCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
  };
});

import { initS3, putL2Content, getL2Content } from '../../src/services/s3';

describe('s3 service', () => {
  beforeEach(() => {
    mockSend.mockReset();
    initS3('test-content-bucket');
  });

  describe('putL2Content', () => {
    it('calls PutObjectCommand with correct bucket and content', async () => {
      mockSend.mockResolvedValueOnce({});

      await putL2Content('l2/resources/doc.md', '# Document content');

      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.Bucket).toBe('test-content-bucket');
      expect(sentCommand.input.Key).toBe('l2/resources/doc.md');
      expect(sentCommand.input.Body).toBe('# Document content');
      expect(sentCommand.input.ContentType).toBe('text/markdown; charset=utf-8');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('getL2Content', () => {
    it('returns content string from GetObjectCommand', async () => {
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToString: vi.fn().mockResolvedValue('# Retrieved content'),
        },
      });

      const result = await getL2Content('l2/resources/doc.md');

      expect(result).toBe('# Retrieved content');
      const sentCommand = mockSend.mock.calls[0][0];
      expect(sentCommand.input.Bucket).toBe('test-content-bucket');
      expect(sentCommand.input.Key).toBe('l2/resources/doc.md');
    });
  });
});
