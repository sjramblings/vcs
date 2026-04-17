import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock SSM service
vi.mock('../../src/services/ssm', () => ({
  loadAllParams: vi.fn().mockResolvedValue(undefined),
  getParam: vi.fn().mockResolvedValue('vcs-context'),
}));

// Mock DynamoDB service
vi.mock('../../src/services/dynamodb', () => ({
  initDynamoDB: vi.fn(),
  queryChildren: vi.fn(),
  getItem: vi.fn(),
  putItem: vi.fn(),
  putItemIfNotExists: vi.fn(),
}));

// Mock S3 service — handleRead hits getL2Content when level=2 has an s3_key
vi.mock('../../src/services/s3', () => ({
  initS3: vi.fn(),
  getL2Content: vi.fn().mockResolvedValue('mocked-l2-content'),
  putL2Content: vi.fn().mockResolvedValue(undefined),
  deleteL2Content: vi.fn().mockResolvedValue(undefined),
  archiveSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock S3 Vectors — handleWrite-style paths in filesystem touch the vectors index
vi.mock('../../src/services/s3-vectors', () => ({
  initS3Vectors: vi.fn(),
  putVector: vi.fn().mockResolvedValue(undefined),
  deleteVector: vi.fn().mockResolvedValue(undefined),
  awaitVectorVisibility: vi.fn().mockResolvedValue({ visible: true, attempts: 1 }),
}));

import { handler } from '../../src/lambdas/filesystem/handler';
import {
  queryChildren,
  getItem,
  putItemIfNotExists,
} from '../../src/services/dynamodb';

const mockQueryChildren = vi.mocked(queryChildren);
const mockGetItem = vi.mocked(getItem);
const mockPutItemIfNotExists = vi.mocked(putItemIfNotExists);

/**
 * Helper to build a minimal APIGatewayProxyEvent.
 * resource should be '/fs/ls', '/fs/tree', etc. (without /v1/ prefix).
 */
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

const NOW = '2026-03-19T00:00:00.000Z';

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

describe('Filesystem Lambda handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── ls ─────────────────────────────────────────────────────────────

  describe('GET /fs/ls', () => {
    it('returns items array with correct fields for valid directory URI', async () => {
      const items = [
        makeContextItem({ uri: 'viking://resources/docs/' }),
        makeContextItem({
          uri: 'viking://resources/config.yaml',
          is_directory: false,
        }),
      ];
      mockQueryChildren.mockResolvedValue({ items: items as any });

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/ls',
        queryStringParameters: { uri: 'viking://resources/' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toEqual({
        uri: 'viking://resources/docs/',
        is_directory: true,
        context_type: 'resource',
        created_at: NOW,
        updated_at: NOW,
      });
    });

    it('passes nextToken to queryChildren and returns new nextToken', async () => {
      const token = Buffer.from(
        JSON.stringify({ uri: 'viking://resources/a/', level: 0 })
      ).toString('base64');

      mockQueryChildren.mockResolvedValue({
        items: [makeContextItem()] as any,
        nextToken: 'newtoken123',
      });

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/ls',
        queryStringParameters: {
          uri: 'viking://resources/',
          nextToken: token,
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.nextToken).toBe('newtoken123');
      expect(mockQueryChildren).toHaveBeenCalledWith('viking://resources/', {
        limit: 50,
        nextToken: token,
      });
    });

    it('returns 400 for invalid URI', async () => {
      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/ls',
        queryStringParameters: { uri: 'not-a-viking-uri' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });
  });

  // ── tree ───────────────────────────────────────────────────────────

  describe('GET /fs/tree', () => {
    it('returns nested structure up to default depth 3', async () => {
      // Root has one child dir, which has one child dir
      mockGetItem.mockImplementation(async (uri: string) => {
        if (uri === 'viking://resources/')
          return makeContextItem({ uri: 'viking://resources/' }) as any;
        if (uri === 'viking://resources/docs/')
          return makeContextItem({ uri: 'viking://resources/docs/' }) as any;
        if (uri === 'viking://resources/docs/auth/')
          return makeContextItem({
            uri: 'viking://resources/docs/auth/',
          }) as any;
        return null;
      });

      mockQueryChildren.mockImplementation(async (parentUri: string) => {
        if (parentUri === 'viking://resources/')
          return {
            items: [
              makeContextItem({ uri: 'viking://resources/docs/' }),
            ] as any,
          };
        if (parentUri === 'viking://resources/docs/')
          return {
            items: [
              makeContextItem({ uri: 'viking://resources/docs/auth/' }),
            ] as any,
          };
        return { items: [] };
      });

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/tree',
        queryStringParameters: { uri: 'viking://resources/' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.root.uri).toBe('viking://resources/');
      expect(body.root.children).toHaveLength(1);
      expect(body.root.children[0].uri).toBe('viking://resources/docs/');
      expect(body.root.children[0].children).toHaveLength(1);
    });

    it('returns only immediate children with depth=1', async () => {
      mockGetItem.mockResolvedValue(
        makeContextItem({ uri: 'viking://resources/' }) as any
      );
      mockQueryChildren.mockResolvedValue({
        items: [
          makeContextItem({ uri: 'viking://resources/docs/' }),
        ] as any,
      });

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/tree',
        queryStringParameters: { uri: 'viking://resources/', depth: '1' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.root.children).toHaveLength(1);
      // At depth 1, children should not have their own children expanded
      expect(body.root.children[0].children).toBeUndefined();
    });

    it('returns root with empty children array for empty directory', async () => {
      mockGetItem.mockResolvedValue(
        makeContextItem({ uri: 'viking://resources/' }) as any
      );
      mockQueryChildren.mockResolvedValue({ items: [] });

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/tree',
        queryStringParameters: { uri: 'viking://resources/' },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.root.uri).toBe('viking://resources/');
      expect(body.root.children).toEqual([]);
    });
  });

  // ── read ───────────────────────────────────────────────────────────

  describe('GET /fs/read', () => {
    it('returns content string for uri + level=0', async () => {
      mockGetItem.mockResolvedValue(
        makeContextItem({
          uri: 'viking://resources/docs/auth/',
          content: 'Authentication overview with JWT tokens',
        }) as any
      );

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/read',
        queryStringParameters: {
          uri: 'viking://resources/docs/auth/',
          level: '0',
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.uri).toBe('viking://resources/docs/auth/');
      expect(body.level).toBe(0);
      expect(body.content).toBe('Authentication overview with JWT tokens');
      expect(body.tokens).toBe(
        Math.ceil('Authentication overview with JWT tokens'.length / 4)
      );
    });

    it('returns 404 for non-existent URI', async () => {
      mockGetItem.mockResolvedValue(null);

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/read',
        queryStringParameters: {
          uri: 'viking://resources/nonexistent/',
          level: '0',
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);

      const body = JSON.parse(result.body);
      expect(body.error).toBe('not_found');
    });

    it('returns s3_key in response for level=2 with s3_key', async () => {
      mockGetItem.mockResolvedValue(
        makeContextItem({
          uri: 'viking://resources/docs/auth/',
          content: '',
          s3_key: 'l2/resources/docs/auth/content.md',
        }) as any
      );

      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/read',
        queryStringParameters: {
          uri: 'viking://resources/docs/auth/',
          level: '2',
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      const body = JSON.parse(result.body);
      expect(body.s3_key).toBe('l2/resources/docs/auth/content.md');
    });
  });

  // ── mkdir ──────────────────────────────────────────────────────────

  describe('POST /fs/mkdir', () => {
    it('creates item and returns 201 for valid directory URI', async () => {
      mockPutItemIfNotExists.mockResolvedValue(true);

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mkdir',
        body: JSON.stringify({ uri: 'viking://resources/new-dir/' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);

      const body = JSON.parse(result.body);
      expect(body.uri).toBe('viking://resources/new-dir/');
      expect(body.created).toBe(true);

      expect(mockPutItemIfNotExists).toHaveBeenCalledWith(
        expect.objectContaining({
          uri: 'viking://resources/new-dir/',
          level: 0,
          parent_uri: 'viking://resources/',
          is_directory: true,
          processing_status: 'ready',
        })
      );
    });

    it('returns 409 for already-existing directory', async () => {
      mockPutItemIfNotExists.mockResolvedValue(false);

      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mkdir',
        body: JSON.stringify({ uri: 'viking://resources/existing/' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(409);

      const body = JSON.parse(result.body);
      expect(body.error).toBe('conflict');
    });

    it('returns 400 for non-directory URI (no trailing /)', async () => {
      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mkdir',
        body: JSON.stringify({ uri: 'viking://resources/not-a-dir' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    it('infers context_type from URI scope', async () => {
      mockPutItemIfNotExists.mockResolvedValue(true);

      // viking://user/ scope should infer 'memory'
      const event = makeEvent({
        httpMethod: 'POST',
        resource: '/fs/mkdir',
        body: JSON.stringify({ uri: 'viking://user/preferences/' }),
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(201);

      expect(mockPutItemIfNotExists).toHaveBeenCalledWith(
        expect.objectContaining({
          context_type: 'memory',
        })
      );
    });
  });

  // ── routing ────────────────────────────────────────────────────────

  describe('routing', () => {
    it('returns 404 for unknown endpoint', async () => {
      const event = makeEvent({
        httpMethod: 'GET',
        resource: '/fs/unknown',
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(404);
    });
  });
});
