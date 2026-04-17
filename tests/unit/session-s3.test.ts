import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => {
  const mockSend = vi.fn();
  return { mockSend };
});

vi.mock('@aws-sdk/client-s3', () => {
  function MockS3Client() { (this as Record<string, unknown>).send = mockSend; }
  function MockPutObjectCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockGetObjectCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  function MockDeleteObjectCommand(input: unknown) { (this as Record<string, unknown>).input = input; }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
  };
});

import { initS3, archiveSession, deleteS3Object } from '../../src/services/s3';

describe('s3 session services', () => {
  beforeEach(() => {
    mockSend.mockReset();
    initS3('test-content-bucket');
  });

  describe('archiveSession', () => {
    it('writes messages.json and summary.json to archives/{sessionId}/', async () => {
      mockSend
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const messages = [{ role: 'user', content: 'Hello' }];
      const summary = { one_line: 'Test session' };

      await archiveSession('sess-1', messages, summary);

      expect(mockSend).toHaveBeenCalledTimes(2);

      const cmd1 = mockSend.mock.calls[0][0];
      expect(cmd1.input.Key).toBe('archives/sess-1/messages.json');
      expect(cmd1.input.Bucket).toBe('test-content-bucket');

      const cmd2 = mockSend.mock.calls[1][0];
      expect(cmd2.input.Key).toBe('archives/sess-1/summary.json');
    });
  });

  describe('deleteS3Object', () => {
    it('sends DeleteObjectCommand with correct key', async () => {
      mockSend.mockResolvedValueOnce({});

      await deleteS3Object('l2/resources/doc.md');

      const cmd = mockSend.mock.calls[0][0];
      expect(cmd.input.Bucket).toBe('test-content-bucket');
      expect(cmd.input.Key).toBe('l2/resources/doc.md');
    });
  });
});
