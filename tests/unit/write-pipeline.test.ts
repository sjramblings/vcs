import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock DynamoDB service
vi.mock('../../src/services/dynamodb', () => ({
  initDynamoDB: vi.fn(),
  putItem: vi.fn().mockResolvedValue(undefined),
  transactWriteItems: vi.fn().mockResolvedValue(undefined),
  acquireProcessingLock: vi.fn().mockResolvedValue(true),
  resetProcessingStatus: vi.fn().mockResolvedValue(undefined),
}));

// Mock Bedrock service
vi.mock('../../src/services/bedrock', () => ({
  initBedrock: vi.fn(),
  summariseDocument: vi.fn().mockResolvedValue({
    abstract: 'Test abstract',
    sections: [{ title: 'Section 1', summary: 'Summary 1' }],
  }),
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)),
}));

// Mock S3 service
vi.mock('../../src/services/s3', () => ({
  initS3: vi.fn(),
  putL2Content: vi.fn().mockResolvedValue(undefined),
}));

// Mock S3 Vectors service
vi.mock('../../src/services/s3-vectors', () => ({
  initS3Vectors: vi.fn(),
  putVector: vi.fn().mockResolvedValue(undefined),
  awaitVectorVisibility: vi.fn().mockResolvedValue({ visible: true, attempts: 1 }),
}));

// Mock SQS service
vi.mock('../../src/services/sqs', () => ({
  initSqs: vi.fn(),
  enqueueRollup: vi.fn().mockResolvedValue(undefined),
}));

import { writeDocument } from '../../src/services/write-pipeline';
import {
  putItem,
  transactWriteItems,
  acquireProcessingLock,
  resetProcessingStatus,
} from '../../src/services/dynamodb';
import {
  summariseDocument,
  generateEmbedding,
} from '../../src/services/bedrock';
import { putL2Content } from '../../src/services/s3';
import { putVector, awaitVectorVisibility } from '../../src/services/s3-vectors';
import { enqueueRollup } from '../../src/services/sqs';

const mockPutItem = vi.mocked(putItem);
const mockTransactWriteItems = vi.mocked(transactWriteItems);
const mockAcquireProcessingLock = vi.mocked(acquireProcessingLock);
const mockResetProcessingStatus = vi.mocked(resetProcessingStatus);
const mockSummariseDocument = vi.mocked(summariseDocument);
const mockGenerateEmbedding = vi.mocked(generateEmbedding);
const mockPutL2Content = vi.mocked(putL2Content);
const mockPutVector = vi.mocked(putVector);
const mockAwaitVectorVisibility = vi.mocked(awaitVectorVisibility);
const mockEnqueueRollup = vi.mocked(enqueueRollup);

// Long content that exceeds SHORT_CONTENT_TOKEN_THRESHOLD (200 tokens ~ 800 chars)
const longContent = '# Comprehensive Guide\n\n' + 'This document covers a wide range of topics including architecture, design patterns, and implementation strategies. '.repeat(12);
const shortContent = '# Hello\n\nShort.';

describe('writeDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireProcessingLock.mockResolvedValue(true);
    mockSummariseDocument.mockResolvedValue({
      abstract: 'Test abstract',
      sections: [{ title: 'Section 1', summary: 'Summary 1' }],
    });
    mockGenerateEmbedding.mockResolvedValue(new Array(1024).fill(0.1));
    mockAwaitVectorVisibility.mockResolvedValue({ visible: true, attempts: 1 });
  });

  it('returns lockAcquired=false when lock not available and requireLock=false', async () => {
    mockAcquireProcessingLock.mockResolvedValue(false);
    const result = await writeDocument({
      uri: 'viking://resources/docs/test.md',
      content: longContent,
      requireLock: false,
    });
    expect(result.lockAcquired).toBe(false);
    expect(mockPutL2Content).not.toHaveBeenCalled();
  });

  it('stores L2 content in S3', async () => {
    await writeDocument({ uri: 'viking://resources/docs/test.md', content: longContent });
    expect(mockPutL2Content).toHaveBeenCalledWith('l2/resources/docs/test.md', longContent);
  });

  it('writes L0, L1, L2 items to DynamoDB atomically', async () => {
    await writeDocument({ uri: 'viking://resources/docs/test.md', content: longContent });
    expect(mockTransactWriteItems).toHaveBeenCalledTimes(1);

    const items = mockTransactWriteItems.mock.calls[0][0];
    const l0Item = items.find((c: any) => c.level === 0);
    expect(l0Item).toBeDefined();
    expect(l0Item.content).toBe('Test abstract');

    const l1Item = items.find((c: any) => c.level === 1);
    expect(l1Item).toBeDefined();

    const l2Item = items.find((c: any) => c.level === 2);
    expect(l2Item).toBeDefined();
    expect(l2Item.s3_key).toBe('l2/resources/docs/test.md');
  });

  it('generates embedding and stores vector', async () => {
    await writeDocument({ uri: 'viking://resources/docs/test.md', content: longContent });
    expect(mockGenerateEmbedding).toHaveBeenCalledWith('Test abstract\n\nSection 1: Summary 1');
    expect(mockPutVector).toHaveBeenCalledWith(
      'viking://resources/docs/test.md',
      'viking://resources/docs/',
      'resource',
      0,
      'Test abstract',
      expect.any(Array)
    );
  });

  it('returns processingStatus=ready when vector visible', async () => {
    const result = await writeDocument({ uri: 'viking://resources/docs/test.md', content: longContent });
    expect(result.processingStatus).toBe('ready');
    expect(result.lockAcquired).toBe(true);
  });

  it('returns processingStatus=indexing when vector not visible', async () => {
    mockAwaitVectorVisibility.mockResolvedValue({ visible: false, attempts: 5 });
    const result = await writeDocument({ uri: 'viking://resources/docs/test.md', content: longContent });
    expect(result.processingStatus).toBe('indexing');
  });

  it('bypasses summarisation for short content', async () => {
    await writeDocument({ uri: 'viking://resources/docs/short.md', content: shortContent });
    expect(mockSummariseDocument).not.toHaveBeenCalled();
    const items = mockTransactWriteItems.mock.calls[0][0];
    const l0Item = items.find((c: any) => c.level === 0);
    expect(l0Item.content).toBe(shortContent);
  });

  it('passes instruction to summariseDocument', async () => {
    await writeDocument({
      uri: 'viking://resources/docs/test.md',
      content: longContent,
      instruction: 'Focus on security',
    });
    expect(mockSummariseDocument).toHaveBeenCalledWith(longContent, 'Focus on security');
  });

  it('resets processing status on error', async () => {
    mockSummariseDocument.mockRejectedValue(new Error('Bedrock failed'));
    await expect(writeDocument({
      uri: 'viking://resources/docs/test.md',
      content: longContent,
    })).rejects.toThrow('Bedrock failed');
    expect(mockResetProcessingStatus).toHaveBeenCalledWith('viking://resources/docs/test.md', 'pending');
  });

  it('maps wiki scope to wiki context type', async () => {
    await writeDocument({ uri: 'viking://wiki/docs/test.md', content: longContent });
    const items = mockTransactWriteItems.mock.calls[0][0];
    const l0Item = items.find((c: any) => c.level === 0);
    expect(l0Item.context_type).toBe('wiki');
  });

  it('maps schema scope to schema context type', async () => {
    await writeDocument({ uri: 'viking://schema/api/v1.md', content: longContent });
    const items = mockTransactWriteItems.mock.calls[0][0];
    const l0Item = items.find((c: any) => c.level === 0);
    expect(l0Item.context_type).toBe('schema');
  });

  it('maps log scope to log context type', async () => {
    await writeDocument({ uri: 'viking://log/2026/04/entry.md', content: longContent });
    const items = mockTransactWriteItems.mock.calls[0][0];
    const l0Item = items.find((c: any) => c.level === 0);
    expect(l0Item.context_type).toBe('log');
  });

  describe('rollup enqueue wiring', () => {
    it('enqueues the parent exactly once on successful write', async () => {
      await writeDocument({
        uri: 'viking://resources/docs/test.md',
        content: longContent,
      });

      expect(mockEnqueueRollup).toHaveBeenCalledTimes(1);
      expect(mockEnqueueRollup).toHaveBeenCalledWith('viking://resources/docs/');
    });

    it('does NOT enqueue when parentUri is root', async () => {
      // A top-level scope URI like viking://resources/ has parentUri === 'viking://' (root).
      await writeDocument({
        uri: 'viking://resources/',
        content: longContent,
      });

      expect(mockEnqueueRollup).not.toHaveBeenCalled();
    });

    it('does NOT enqueue when the write fails before the rollup step', async () => {
      // putVector failure at the final attempt — the enqueue block never runs.
      mockPutVector.mockRejectedValue(new Error('vector bucket 500'));

      await expect(
        writeDocument({
          uri: 'viking://resources/docs/test.md',
          content: longContent,
        })
      ).rejects.toThrow('vector bucket 500');

      expect(mockEnqueueRollup).not.toHaveBeenCalled();
    });
  });
});
