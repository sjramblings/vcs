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
  queryChildren: vi.fn(),
  getItem: vi.fn(),
  putItem: vi.fn(),
  putItemIfNotExists: vi.fn(),
  batchDeleteItems: vi.fn().mockResolvedValue(undefined),
  deleteItem: vi.fn().mockResolvedValue(undefined),
}));

// Mock S3 service
vi.mock('../../src/services/s3', () => ({
  initS3: vi.fn(),
  deleteS3Object: vi.fn().mockResolvedValue(undefined),
}));

// Mock S3 Vectors service
vi.mock('../../src/services/s3-vectors', () => ({
  initS3Vectors: vi.fn(),
  deleteVector: vi.fn().mockResolvedValue(undefined),
  getVectors: vi.fn().mockResolvedValue([]),
  putVector: vi.fn().mockResolvedValue(undefined),
}));

import { handler } from '../../src/lambdas/filesystem/handler';
import {
  queryChildren,
  getItem,
  putItem,
  batchDeleteItems,
} from '../../src/services/dynamodb';
import { deleteS3Object } from '../../src/services/s3';
import {
  deleteVector,
  getVectors,
  putVector,
} from '../../src/services/s3-vectors';

const mockQueryChildren = vi.mocked(queryChildren);
const mockGetItem = vi.mocked(getItem);
const mockPutItem = vi.mocked(putItem);
const mockBatchDeleteItems = vi.mocked(batchDeleteItems);
const mockDeleteS3Object = vi.mocked(deleteS3Object);
const mockDeleteVector = vi.mocked(deleteVector);
const mockGetVectors = vi.mocked(getVectors);
const mockPutVector = vi.mocked(putVector);

const NOW = '2026-03-19T00:00:00.000Z';

function makeEvent(
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    resource: '/fs/ls',
    path: '/fs/ls',
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    headers: {},
    multiValueHeaders: {},
    body: null,
    isBase64Encoded: false,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    ...overrides,
  };
}

function makeContextItem(overrides: Record<string, unknown> = {}) {
  return {
    uri: 'viking://resources/docs/',
    level: 0,
    parent_uri: 'viking://resources/',
    context_type: 'resource',
    is_directory: true,
    processing_status: 'ready',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

// ── DELETE /fs/rm ──────────────────────────────────────────────────

describe('Filesystem mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DELETE /fs/rm', () => {
    it('deletes vectors first, then DynamoDB items, then S3 content', async () => {
      const callOrder: string[] = [];

      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (uri === 'viking://resources/docs/auth.md' && level === 0) {
          return makeContextItem({
            uri: 'viking://resources/docs/auth.md',
            is_directory: false,
            processing_status: 'ready',
          }) as any;
        }
        if (uri === 'viking://resources/docs/auth.md' && level === 2) {
          return makeContextItem({
            uri: 'viking://resources/docs/auth.md',
            level: 2,
            s3_key: 'l2/resources/docs/auth.md',
          }) as any;
        }
        return null;
      });

      // No children (it's a file)
      mockQueryChildren.mockResolvedValue({ items: [] });

      mockDeleteVector.mockImplementation(async () => {
        callOrder.push('deleteVector');
      });
      mockBatchDeleteItems.mockImplementation(async () => {
        callOrder.push('batchDeleteItems');
      });
      mockDeleteS3Object.mockImplementation(async () => {
        callOrder.push('deleteS3Object');
      });

      const event = makeEvent({
        httpMethod: 'DELETE',
        resource: '/fs/rm',
        queryStringParameters: { uri: 'viking://resources/docs/auth.md' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('ok');
      expect(body.deleted).toBe(1);

      // Verify ordering: vectors -> dynamo -> s3
      expect(callOrder.indexOf('deleteVector')).toBeLessThan(
        callOrder.indexOf('batchDeleteItems')
      );
      expect(callOrder.indexOf('batchDeleteItems')).toBeLessThan(
        callOrder.indexOf('deleteS3Object')
      );
    });

    it('collects all descendants via BFS and deletes all', async () => {
      // Directory with nested children
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (level === 0) {
          if (uri === 'viking://resources/docs/') {
            return makeContextItem({
              uri: 'viking://resources/docs/',
              is_directory: true,
            }) as any;
          }
          if (uri === 'viking://resources/docs/sub/') {
            return makeContextItem({
              uri: 'viking://resources/docs/sub/',
              is_directory: true,
            }) as any;
          }
          if (uri === 'viking://resources/docs/sub/file.md') {
            return makeContextItem({
              uri: 'viking://resources/docs/sub/file.md',
              is_directory: false,
            }) as any;
          }
        }
        return null;
      });

      mockQueryChildren.mockImplementation(async (parentUri: string) => {
        if (parentUri === 'viking://resources/docs/') {
          return {
            items: [
              makeContextItem({
                uri: 'viking://resources/docs/sub/',
                is_directory: true,
              }),
            ] as any,
          };
        }
        if (parentUri === 'viking://resources/docs/sub/') {
          return {
            items: [
              makeContextItem({
                uri: 'viking://resources/docs/sub/file.md',
                is_directory: false,
              }),
            ] as any,
          };
        }
        return { items: [] };
      });

      const event = makeEvent({
        httpMethod: 'DELETE',
        resource: '/fs/rm',
        queryStringParameters: { uri: 'viking://resources/docs/' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.deleted).toBe(3); // docs/ + docs/sub/ + docs/sub/file.md

      // Should have called deleteVector for each URI
      expect(mockDeleteVector).toHaveBeenCalledTimes(3);
    });

    it('returns 409 when processing_status=processing', async () => {
      mockGetItem.mockResolvedValue(
        makeContextItem({
          uri: 'viking://resources/docs/auth.md',
          processing_status: 'processing',
          is_directory: false,
        }) as any
      );

      const event = makeEvent({
        httpMethod: 'DELETE',
        resource: '/fs/rm',
        queryStringParameters: { uri: 'viking://resources/docs/auth.md' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(409);

      const body = JSON.parse(result.body);
      expect(body.error).toBe('conflict');
    });

    it('returns 404 when URI does not exist', async () => {
      mockGetItem.mockResolvedValue(null);

      const event = makeEvent({
        httpMethod: 'DELETE',
        resource: '/fs/rm',
        queryStringParameters: { uri: 'viking://resources/nonexistent.md' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('returns 200 with deleted count', async () => {
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (level === 0) {
          return makeContextItem({
            uri: 'viking://resources/docs/auth.md',
            is_directory: false,
          }) as any;
        }
        return null;
      });
      mockQueryChildren.mockResolvedValue({ items: [] });

      const event = makeEvent({
        httpMethod: 'DELETE',
        resource: '/fs/rm',
        queryStringParameters: { uri: 'viking://resources/docs/auth.md' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body).toEqual({ status: 'ok', deleted: 1 });
    });
  });

  // ── POST /fs/mv ──────────────────────────────────────────────────

  describe('POST /fs/mv', () => {
    it('copies all items to new URIs, updates vectors, then deletes old', async () => {
      const callOrder: string[] = [];

      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (uri === 'viking://resources/old/doc.md' && level === 0) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            is_directory: false,
            content: 'doc content L0',
            context_type: 'resource',
          }) as any;
        }
        if (uri === 'viking://resources/old/doc.md' && level === 1) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            level: 1,
            content: 'doc content L1',
          }) as any;
        }
        if (uri === 'viking://resources/old/doc.md' && level === 2) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            level: 2,
            content: 'doc content L2',
            s3_key: 'l2/resources/old/doc.md',
          }) as any;
        }
        return null;
      });

      mockQueryChildren.mockResolvedValue({ items: [] });

      mockGetVectors.mockResolvedValue([
        {
          key: 'viking://resources/old/doc.md',
          data: [0.1, 0.2, 0.3],
          metadata: {
            uri: 'viking://resources/old/doc.md',
            parent_uri: 'viking://resources/old/',
            context_type: 'resource',
            level: 0,
            abstract: 'doc abstract',
          },
        },
      ]);

      mockPutItem.mockImplementation(async () => {
        callOrder.push('putItem');
      });
      mockDeleteVector.mockImplementation(async () => {
        callOrder.push('deleteVector');
      });
      mockPutVector.mockImplementation(async () => {
        callOrder.push('putVector');
      });
      mockBatchDeleteItems.mockImplementation(async () => {
        callOrder.push('batchDeleteItems');
      });
      mockDeleteS3Object.mockImplementation(async () => {
        callOrder.push('deleteS3Object');
      });

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('ok');
      expect(body.moved).toBe(1);

      // putItem (copy) should happen before delete
      expect(callOrder.indexOf('putItem')).toBeLessThan(
        callOrder.indexOf('batchDeleteItems')
      );
    });

    it('moves all descendants with rewritten URIs', async () => {
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (level === 0) {
          if (uri === 'viking://resources/old/') {
            return makeContextItem({
              uri: 'viking://resources/old/',
              is_directory: true,
            }) as any;
          }
          if (uri === 'viking://resources/old/file.md') {
            return makeContextItem({
              uri: 'viking://resources/old/file.md',
              is_directory: false,
              content: 'file content',
            }) as any;
          }
        }
        return null;
      });

      mockQueryChildren.mockImplementation(async (parentUri: string) => {
        if (parentUri === 'viking://resources/old/') {
          return {
            items: [
              makeContextItem({
                uri: 'viking://resources/old/file.md',
                is_directory: false,
              }),
            ] as any,
          };
        }
        return { items: [] };
      });

      mockGetVectors.mockResolvedValue([]);

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/',
          to_uri: 'viking://resources/new/',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.moved).toBe(2); // old/ + old/file.md

      // Verify putItem was called with rewritten URIs
      const putItemCalls = mockPutItem.mock.calls;
      const uris = putItemCalls.map((call) => (call[0] as any).uri);
      expect(uris).toContain('viking://resources/new/');
      expect(uris).toContain('viking://resources/new/file.md');
    });

    it('returns 409 when processing_status=processing', async () => {
      mockGetItem.mockResolvedValue(
        makeContextItem({
          uri: 'viking://resources/old/doc.md',
          processing_status: 'processing',
          is_directory: false,
        }) as any
      );

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(409);
    });

    it('returns 404 when source URI does not exist', async () => {
      mockGetItem.mockResolvedValue(null);

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });

    it('re-uses existing embeddings via getVectors (no re-embedding)', async () => {
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (uri === 'viking://resources/old/doc.md' && level === 0) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            is_directory: false,
          }) as any;
        }
        return null;
      });
      mockQueryChildren.mockResolvedValue({ items: [] });

      const embedding = [0.1, 0.2, 0.3, 0.4];
      mockGetVectors.mockResolvedValue([
        {
          key: 'viking://resources/old/doc.md',
          data: embedding,
          metadata: {
            uri: 'viking://resources/old/doc.md',
            parent_uri: 'viking://resources/old/',
            context_type: 'resource',
            level: 0,
            abstract: 'doc abstract',
          },
        },
      ]);

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      // getVectors was called with old URIs
      expect(mockGetVectors).toHaveBeenCalledWith(['viking://resources/old/doc.md']);

      // putVector was called with new URI and SAME embedding
      expect(mockPutVector).toHaveBeenCalledWith(
        'viking://resources/new/doc.md',
        'viking://resources/new/',
        'resource',
        0,
        'doc abstract',
        embedding
      );

      // deleteVector was called to remove old
      expect(mockDeleteVector).toHaveBeenCalledWith('viking://resources/old/doc.md');
    });

    it('is resumable -- partial failure leaves both copies', async () => {
      // The move protocol is copy-first, delete-second.
      // If delete fails, both copies exist -- the user can retry.
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (uri === 'viking://resources/old/doc.md' && level === 0) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            is_directory: false,
          }) as any;
        }
        return null;
      });
      mockQueryChildren.mockResolvedValue({ items: [] });
      mockGetVectors.mockResolvedValue([]);

      // Delete phase throws
      mockBatchDeleteItems.mockRejectedValue(new Error('DynamoDB timeout'));

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      // Should return 500 since the delete failed
      expect(result.statusCode).toBe(500);

      // But putItem was called (copy was done before delete)
      expect(mockPutItem).toHaveBeenCalled();
    });

    it('deleteVector throws during mv → move still completes with 200', async () => {
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (uri === 'viking://resources/old/doc.md' && level === 0) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            is_directory: false,
          }) as any;
        }
        return null;
      });
      mockQueryChildren.mockResolvedValue({ items: [] });
      mockBatchDeleteItems.mockResolvedValue(undefined);

      mockGetVectors.mockResolvedValue([
        {
          key: 'viking://resources/old/doc.md',
          data: [0.1, 0.2],
          metadata: {
            uri: 'viking://resources/old/doc.md',
            parent_uri: 'viking://resources/old/',
            context_type: 'resource',
            level: 0,
            abstract: 'doc abstract',
          },
        },
      ]);

      mockDeleteVector.mockRejectedValue(new Error('Vector service unavailable'));

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('ok');

      // Step 3 still ran
      expect(mockBatchDeleteItems).toHaveBeenCalled();
    });

    it('putVector throws during mv → move still completes with 200', async () => {
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (uri === 'viking://resources/old/doc.md' && level === 0) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            is_directory: false,
          }) as any;
        }
        return null;
      });
      mockQueryChildren.mockResolvedValue({ items: [] });
      mockBatchDeleteItems.mockResolvedValue(undefined);

      mockGetVectors.mockResolvedValue([
        {
          key: 'viking://resources/old/doc.md',
          data: [0.1, 0.2],
          metadata: {
            uri: 'viking://resources/old/doc.md',
            parent_uri: 'viking://resources/old/',
            context_type: 'resource',
            level: 0,
            abstract: 'doc abstract',
          },
        },
      ]);

      mockDeleteVector.mockResolvedValue(undefined);
      mockPutVector.mockRejectedValue(new Error('Vector write failed'));

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.status).toBe('ok');

      // Step 3 still ran
      expect(mockBatchDeleteItems).toHaveBeenCalled();
    });

    it('partial vector failure (delete ok, put fails) → move completes', async () => {
      mockGetItem.mockImplementation(async (uri: string, level: number) => {
        if (uri === 'viking://resources/old/doc.md' && level === 0) {
          return makeContextItem({
            uri: 'viking://resources/old/doc.md',
            is_directory: false,
          }) as any;
        }
        return null;
      });
      mockQueryChildren.mockResolvedValue({ items: [] });
      mockBatchDeleteItems.mockResolvedValue(undefined);

      mockGetVectors.mockResolvedValue([
        {
          key: 'viking://resources/old/doc.md',
          data: [0.1, 0.2],
          metadata: {
            uri: 'viking://resources/old/doc.md',
            parent_uri: 'viking://resources/old/',
            context_type: 'resource',
            level: 0,
            abstract: 'doc abstract',
          },
        },
      ]);

      // putVector runs first (put-before-delete ordering); if it fails,
      // deleteVector is never reached — old vector stays valid.
      let putVectorCalled = false;
      mockPutVector.mockImplementation(async () => {
        putVectorCalled = true;
        throw new Error('Partial failure');
      });
      mockDeleteVector.mockResolvedValue(undefined);

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mv',
        body: JSON.stringify({
          from_uri: 'viking://resources/old/doc.md',
          to_uri: 'viking://resources/new/doc.md',
        }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      expect(putVectorCalled).toBe(true);
      // deleteVector should NOT be called since putVector failed first
      expect(mockDeleteVector).not.toHaveBeenCalled();
      expect(mockBatchDeleteItems).toHaveBeenCalled();
    });
  });
});
