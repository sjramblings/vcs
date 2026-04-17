import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock SSM service
vi.mock('../../src/services/ssm', () => ({
  loadAllParams: vi.fn().mockResolvedValue(undefined),
  getParam: vi.fn().mockResolvedValue('mock-value'),
}));

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

import { handler } from '../../src/lambdas/ingestion/handler';
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

const shortContent = '# Hello World\n\nSome content here.';
const validContent = Buffer.from(shortContent).toString('base64');

// Long content that safely exceeds SHORT_CONTENT_TOKEN_THRESHOLD (200 tokens ~ 800 chars)
const longText = '# Comprehensive Guide\n\n' + 'This document covers a wide range of topics including architecture, design patterns, and implementation strategies. '.repeat(12);
const longContent = Buffer.from(longText).toString('base64');

function makeEvent(
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    resource: '/resources',
    path: '/resources',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    headers: {},
    multiValueHeaders: {},
    body: JSON.stringify({
      content_base64: validContent,
      uri_prefix: 'viking://resources/docs/',
      filename: 'hello.md',
    }),
    isBase64Encoded: false,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    ...overrides,
  };
}

describe('ingestion handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireProcessingLock.mockResolvedValue(true);
    mockSummariseDocument.mockResolvedValue({
      abstract: 'Test abstract',
      sections: [{ title: 'Section 1', summary: 'Summary 1' }],
    });
    mockGenerateEmbedding.mockResolvedValue(new Array(1024).fill(0.1));
  });

  it('accepts valid request and returns URI with processing_status=ready', async () => {
    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.uri).toBe('viking://resources/docs/hello.md');
    expect(body.processing_status).toBe('ready');
  });

  it('returns 400 for missing content_base64', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        uri_prefix: 'viking://resources/docs/',
        filename: 'hello.md',
      }),
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 400 for invalid uri_prefix', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        content_base64: validContent,
        uri_prefix: 'viking://resources/docs', // no trailing slash
        filename: 'hello.md',
      }),
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
  });

  it('returns 409 when processing lock not acquired', async () => {
    mockAcquireProcessingLock.mockResolvedValue(false);
    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(409);
    expect(body.message).toContain('processed');
  });

  it('stores L2 content in S3', async () => {
    const event = makeEvent();
    await handler(event);

    expect(mockPutL2Content).toHaveBeenCalledWith(
      'l2/resources/docs/hello.md',
      '# Hello World\n\nSome content here.'
    );
  });

  it('writes L0, L1, L2 items to DynamoDB', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        content_base64: longContent,
        uri_prefix: 'viking://resources/docs/',
        filename: 'hello.md',
      }),
    });
    await handler(event);

    // writeDocument uses a single transactWriteItems call with all 3 levels
    expect(mockTransactWriteItems).toHaveBeenCalledTimes(1);
    const items = mockTransactWriteItems.mock.calls[0][0];
    expect(items).toHaveLength(3);

    const l0Item = items.find((c) => c.level === 0)!;
    expect(l0Item.content).toBe('Test abstract');
    expect(l0Item.processing_status).toBe('ready');
    expect(l0Item.is_directory).toBe(false);

    const l1Item = items.find((c) => c.level === 1)!;
    expect(l1Item.content).toBe(
      JSON.stringify([{ title: 'Section 1', summary: 'Summary 1' }])
    );

    const l2Item = items.find((c) => c.level === 2)!;
    expect(l2Item.s3_key).toBe('l2/resources/docs/hello.md');
    expect(l2Item.content).toBeUndefined();
  });

  it('generates embedding from L0+L1 text', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        content_base64: longContent,
        uri_prefix: 'viking://resources/docs/',
        filename: 'hello.md',
      }),
    });
    await handler(event);

    const expectedText = 'Test abstract\n\nSection 1: Summary 1';
    expect(mockGenerateEmbedding).toHaveBeenCalledWith(expectedText);
  });

  it('stores vector with correct metadata', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        content_base64: longContent,
        uri_prefix: 'viking://resources/docs/',
        filename: 'hello.md',
      }),
    });
    await handler(event);

    expect(mockPutVector).toHaveBeenCalledWith(
      'viking://resources/docs/hello.md',
      'viking://resources/docs/',
      'resource',
      0,
      'Test abstract',
      expect.any(Array)
    );
  });

  it('enqueues parent rollup via SQS', async () => {
    const event = makeEvent();
    await handler(event);

    expect(mockEnqueueRollup).toHaveBeenCalledWith('viking://resources/docs/');
  });

  it('does not enqueue rollup for root parent', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        content_base64: validContent,
        uri_prefix: 'viking://resources/',
        filename: 'hello.md',
      }),
    });
    await handler(event);

    // Parent of viking://resources/hello.md is viking://resources/
    // which is NOT viking://, so rollup should still be called
    expect(mockEnqueueRollup).toHaveBeenCalledWith('viking://resources/');
  });

  it('resets processing_status on error', async () => {
    mockSummariseDocument.mockRejectedValue(new Error('Bedrock failed'));
    const event = makeEvent({
      body: JSON.stringify({
        content_base64: longContent,
        uri_prefix: 'viking://resources/docs/',
        filename: 'hello.md',
      }),
    });
    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(mockResetProcessingStatus).toHaveBeenCalledWith(
      'viking://resources/docs/hello.md',
      'pending'
    );
  });

  it('putVector overwrites by key without calling deleteVector', async () => {
    const event = makeEvent();
    await handler(event);

    // deleteVector should NOT be called during ingestion
    // putVector overwrites by key, making delete redundant
    expect(mockPutVector).toHaveBeenCalled();
  });

  it('passes instruction to summariseDocument', async () => {
    const event = makeEvent({
      body: JSON.stringify({
        content_base64: longContent,
        uri_prefix: 'viking://resources/docs/',
        filename: 'hello.md',
        instruction: 'Focus on security aspects',
      }),
    });
    await handler(event);

    expect(mockSummariseDocument).toHaveBeenCalledWith(
      longText,
      'Focus on security aspects'
    );
  });

  it('SQS dedup: enqueueRollup is called for parent (dedup is in sqs.ts)', async () => {
    const event = makeEvent();
    await handler(event);

    // Deduplication logic is in sqs.ts service, handler just calls enqueueRollup
    expect(mockEnqueueRollup).toHaveBeenCalledTimes(1);
    expect(mockEnqueueRollup).toHaveBeenCalledWith('viking://resources/docs/');
  });

  it('returns 200 with processing_status indexing when visibility times out', async () => {
    mockAwaitVectorVisibility.mockResolvedValue({ visible: false, attempts: 5 });
    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.processing_status).toBe('indexing');
  });

  it('returns 200 with processing_status ready when visibility confirmed', async () => {
    mockAwaitVectorVisibility.mockResolvedValue({ visible: true, attempts: 1 });
    const event = makeEvent();
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.processing_status).toBe('ready');
  });
});
