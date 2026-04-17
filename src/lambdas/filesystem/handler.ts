import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { SSM_PATHS, HANDLER_PARAMS } from '../../../lib/config';
import { loadAllParams, getParam } from '../../services/ssm';
import {
  initDynamoDB,
  queryChildren,
  getItem,
  putItem,
  putItemIfNotExists,
  batchDeleteItems,
} from '../../services/dynamodb';
import { initS3, getL2Content, deleteS3Object } from '../../services/s3';
import {
  initS3Vectors,
  deleteVector,
  getVectors,
  putVector,
} from '../../services/s3-vectors';
import {
  lsRequestSchema,
  treeRequestSchema,
  readRequestSchema,
  mkdirRequestSchema,
  rmRequestSchema,
  mvRequestSchema,
} from '../../utils/validators';
import {
  ok,
  created,
  badRequest,
  notFound,
  conflict,
  fromError,
} from '../../utils/response';
import { getParentUri, parseUri } from '../../utils/uri';
import type { TreeNode } from '../../types/api';
import type { ContextItem } from '../../types/context';

const logger = new Logger({ serviceName: 'vcs-filesystem' });
const tracer = new Tracer({ serviceName: 'vcs-filesystem' });
const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-filesystem' });
let initialized = false;

/**
 * Filesystem Lambda handler.
 * Routes: GET /fs/ls, GET /fs/tree, GET /fs/read, POST /fs/mkdir, DELETE /fs/rm, POST /fs/mv
 *
 * NOTE: API Gateway strips the stage prefix (/v1/) from event.resource.
 * Route checks use resource paths without stage prefix.
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('## handler');
  if (subsegment) tracer.setSegment(subsegment);

  tracer.annotateColdStart();
  tracer.addServiceNameAnnotation();

  try {
    if (!initialized) {
      await loadAllParams(HANDLER_PARAMS.filesystem);
      const tableName = await getParam(SSM_PATHS.CONTEXT_TABLE_NAME);
      const contentBucket = await getParam(SSM_PATHS.CONTENT_BUCKET_NAME);
      const vectorBucket = await getParam(SSM_PATHS.VECTOR_BUCKET_NAME);
      const vectorIndex = await getParam(SSM_PATHS.VECTOR_INDEX_NAME);
      initDynamoDB(tableName);
      initS3(contentBucket);
      initS3Vectors(vectorBucket, vectorIndex);
      initialized = true;
    }

    const { httpMethod, resource, queryStringParameters, body } = event;

    let result: APIGatewayProxyResult;

    // resource does NOT include the /v1/ stage prefix.
    // API Gateway stage name is part of the URL but stripped from event.resource.
    if (httpMethod === 'GET' && resource === '/fs/ls')
      result = await handleLs(queryStringParameters);
    else if (httpMethod === 'GET' && resource === '/fs/tree')
      result = await handleTree(queryStringParameters);
    else if (httpMethod === 'GET' && resource === '/fs/read')
      result = await handleRead(queryStringParameters);
    else if (httpMethod === 'POST' && resource === '/fs/mkdir')
      result = await handleMkdir(body);
    else if (httpMethod === 'DELETE' && resource === '/fs/rm')
      result = await handleRm(queryStringParameters);
    else if (httpMethod === 'POST' && resource === '/fs/mv')
      result = await handleMv(body);
    else
      result = notFound('Endpoint not found');

    tracer.addResponseAsMetadata(result, 'handler');
    return result;
  } catch (error) {
    tracer.addErrorAsMetadata(error as Error);
    logger.error('Filesystem operation failed', {
      error: error as Error,
    });
    return fromError(error);
  } finally {
    subsegment?.close();
    if (segment) tracer.setSegment(segment);
  }
};

/**
 * GET /fs/ls -- List children of a directory URI.
 * Returns paginated list with cursor-based nextToken.
 */
async function handleLs(
  params: Record<string, string | undefined> | null
): Promise<APIGatewayProxyResult> {
  const opStart = Date.now();
  metrics.addDimension('Operation', 'ls');

  const parsed = lsRequestSchema.safeParse({
    uri: params?.uri,
    nextToken: params?.nextToken,
    limit: params?.limit ? Number(params.limit) : undefined,
  });

  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  const { uri, nextToken, limit } = parsed.data;
  const result = await queryChildren(uri, { limit: limit ?? 50, nextToken });

  metrics.addMetric('ChildCount', MetricUnit.Count, result.items.length);

  const items = result.items.map((item) => ({
    uri: item.uri,
    is_directory: item.is_directory,
    context_type: item.context_type,
    created_at: item.created_at,
    updated_at: item.updated_at,
  }));

  metrics.addMetric('FilesystemLatency', MetricUnit.Milliseconds, Date.now() - opStart);
  metrics.publishStoredMetrics();
  return ok({ items, nextToken: result.nextToken });
}

/**
 * GET /fs/tree -- Recursive tree from a directory URI.
 * Depth-limited (default 3, max 10).
 */
async function handleTree(
  params: Record<string, string | undefined> | null
): Promise<APIGatewayProxyResult> {
  const opStart = Date.now();
  metrics.addDimension('Operation', 'tree');

  const parsed = treeRequestSchema.safeParse({
    uri: params?.uri,
    depth: params?.depth ? Number(params.depth) : undefined,
  });

  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  const { uri, depth } = parsed.data;
  const maxDepth = depth ?? 3;
  const root = await buildTree(uri, 0, maxDepth);

  metrics.addMetric('TreeDepth', MetricUnit.Count, maxDepth);
  metrics.addMetric('FilesystemLatency', MetricUnit.Milliseconds, Date.now() - opStart);
  metrics.publishStoredMetrics();
  return ok({ root });
}

/**
 * Recursively builds a tree of nodes starting from the given URI.
 */
async function buildTree(
  uri: string,
  currentDepth: number,
  maxDepth: number
): Promise<TreeNode> {
  // Fetch item metadata at level 0 for this node
  const item = await getItem(uri, 0);

  const node: TreeNode = {
    uri,
    is_directory: item?.is_directory ?? true,
    context_type: item?.context_type ?? 'resource',
  };

  if (currentDepth >= maxDepth) {
    return node;
  }

  // Query children and build subtrees
  const result = await queryChildren(uri);
  const children: TreeNode[] = [];

  for (const child of result.items) {
    if (child.is_directory) {
      children.push(await buildTree(child.uri, currentDepth + 1, maxDepth));
    } else {
      children.push({
        uri: child.uri,
        is_directory: false,
        context_type: child.context_type,
      });
    }
  }

  node.children = children;
  return node;
}

/**
 * GET /fs/read -- Read content at a specific URI and level.
 */
async function handleRead(
  params: Record<string, string | undefined> | null
): Promise<APIGatewayProxyResult> {
  const opStart = Date.now();

  const parsed = readRequestSchema.safeParse({
    uri: params?.uri,
    level: params?.level,
  });

  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  const { uri, level } = parsed.data;
  metrics.addDimension('Operation', `read_l${level}`);
  const item = await getItem(uri, level);

  if (!item) {
    return notFound('Content not found at specified URI and level');
  }

  // For level 2, fetch full content from S3
  let content = item.content ?? '';
  if (level === 2 && item.s3_key) {
    const l2Start = Date.now();
    content = await getL2Content(item.s3_key);
    metrics.addMetric('L2FetchLatency', MetricUnit.Milliseconds, Date.now() - l2Start);
  }

  const response: Record<string, unknown> = {
    uri,
    level,
    content,
    tokens: estimateTokens(content),
  };

  if (level === 2 && item.s3_key) {
    response.s3_key = item.s3_key;
  }

  metrics.addMetric('FilesystemLatency', MetricUnit.Milliseconds, Date.now() - opStart);
  metrics.publishStoredMetrics();
  return ok(response);
}

/**
 * POST /fs/mkdir -- Create a directory node.
 * Returns 409 if directory already exists.
 */
async function handleMkdir(
  body: string | null
): Promise<APIGatewayProxyResult> {
  const opStart = Date.now();
  metrics.addDimension('Operation', 'mkdir');

  let parsedBody: unknown;
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch {
    return badRequest('Invalid JSON body');
  }

  const parsed = mkdirRequestSchema.safeParse(parsedBody);

  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  const { uri, context_type } = parsed.data;
  const parentUri = getParentUri(uri);

  // Infer context_type from URI scope if not provided
  const resolvedType = context_type ?? inferContextType(uri);
  const now = new Date().toISOString();

  const item: ContextItem = {
    uri,
    level: 0,
    parent_uri: parentUri ?? 'viking://',
    context_type: resolvedType,
    is_directory: true,
    processing_status: 'ready',
    created_at: now,
    updated_at: now,
  };

  const wasCreated = await putItemIfNotExists(item);

  if (!wasCreated) {
    return conflict('Directory already exists');
  }

  metrics.addMetric('FilesystemLatency', MetricUnit.Milliseconds, Date.now() - opStart);
  metrics.publishStoredMetrics();
  return created({ uri, created: true });
}

/**
 * Infers context_type from the URI scope segment.
 */
function inferContextType(uri: string): ContextItem['context_type'] {
  const parsed = parseUri(uri);
  const scopeMap: Record<string, ContextItem['context_type']> = {
    resources: 'resource',
    user: 'memory',
    agent: 'skill',
    session: 'session',
    wiki: 'wiki',
    schema: 'schema',
    log: 'log',
  };
  return scopeMap[parsed.scope] ?? 'resource';
}

/**
 * Simple token estimation (~4 chars per token).
 */
function estimateTokens(content?: string): number | undefined {
  if (!content) return undefined;
  return Math.ceil(content.length / 4);
}

// ── DELETE /fs/rm ──────────────────────────────────────────────────

/**
 * DELETE /fs/rm -- Delete a node and all its descendants.
 * Uses index-first ordering: vectors, DynamoDB, S3.
 */
async function handleRm(
  params: Record<string, string | undefined> | null
): Promise<APIGatewayProxyResult> {
  const opStart = Date.now();
  metrics.addDimension('Operation', 'rm');

  const parsed = rmRequestSchema.safeParse({
    uri: params?.uri,
  });

  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  const { uri } = parsed.data;
  const item = await getItem(uri, 0);

  if (!item) {
    return notFound('Resource not found');
  }

  if (item.processing_status === 'processing') {
    return conflict('Cannot delete while processing is in progress');
  }

  // Collect self + all descendants via BFS
  const allUris = await collectAllDescendants(uri);

  // Phase 1: Delete vectors (index-first)
  for (const targetUri of allUris) {
    try {
      await deleteVector(targetUri);
    } catch {
      // Vector may not exist for directories -- skip silently
    }
  }

  // Phase 2: Collect S3 keys BEFORE deleting DynamoDB items
  const s3Keys: string[] = [];
  for (const targetUri of allUris) {
    try {
      const l2Item = await getItem(targetUri, 2);
      if (l2Item?.s3_key) {
        s3Keys.push(l2Item.s3_key);
      }
    } catch {
      // Not all items have S3 content -- skip silently
    }
  }

  // Phase 3: Delete DynamoDB items at all levels
  const keys = allUris.flatMap((u) => [
    { uri: u, level: 0 },
    { uri: u, level: 1 },
    { uri: u, level: 2 },
  ]);
  await batchDeleteItems(keys);

  // Phase 4: Delete S3 content using pre-collected keys
  for (const s3Key of s3Keys) {
    try {
      await deleteS3Object(s3Key);
    } catch {
      // S3 deletion is best-effort -- skip silently
    }
  }

  metrics.addMetric('ChildCount', MetricUnit.Count, allUris.length);
  metrics.addMetric('FilesystemLatency', MetricUnit.Milliseconds, Date.now() - opStart);
  metrics.publishStoredMetrics();
  return ok({ status: 'ok', deleted: allUris.length });
}

/**
 * Collects the given URI and all its descendants using BFS.
 * Returns a flat array of all URIs in the subtree.
 */
async function collectAllDescendants(rootUri: string): Promise<string[]> {
  const result: string[] = [];
  const queue: string[] = [rootUri];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    // Paginate through all children
    let nextToken: string | undefined;
    do {
      const children = await queryChildren(current, { nextToken });
      for (const child of children.items) {
        queue.push(child.uri);
      }
      nextToken = children.nextToken;
    } while (nextToken);
  }

  return result;
}

// ── POST /fs/mv ──────────────────────────────────────────────────

/**
 * Rewrites a URI by replacing the fromPrefix with toPrefix.
 */
function rewriteUri(uri: string, fromPrefix: string, toPrefix: string): string {
  return toPrefix + uri.slice(fromPrefix.length);
}

/**
 * POST /fs/mv -- Move/rename a node and all its descendants.
 * Uses copy-update-delete protocol for idempotent, resumable moves.
 */
async function handleMv(
  body: string | null
): Promise<APIGatewayProxyResult> {
  const opStart = Date.now();
  metrics.addDimension('Operation', 'mv');

  let parsedBody: unknown;
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch {
    return badRequest('Invalid JSON body');
  }

  const parsed = mvRequestSchema.safeParse(parsedBody);

  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  const { from_uri, to_uri } = parsed.data;
  const sourceItem = await getItem(from_uri, 0);

  if (!sourceItem) {
    return notFound('Source resource not found');
  }

  if (sourceItem.processing_status === 'processing') {
    return conflict('Cannot move while processing is in progress');
  }

  // Collect all URIs under source
  const allUris = await collectAllDescendants(from_uri);

  // Step 1: Copy items to new URIs
  for (const oldUri of allUris) {
    for (const level of [0, 1, 2]) {
      const existingItem = await getItem(oldUri, level);
      if (existingItem) {
        const newUri = rewriteUri(oldUri, from_uri, to_uri);
        const newParentUri = existingItem.parent_uri.startsWith(from_uri)
          ? rewriteUri(existingItem.parent_uri, from_uri, to_uri)
          : getParentUri(newUri) ?? existingItem.parent_uri;

        const newItem: ContextItem = {
          ...existingItem,
          uri: newUri,
          parent_uri: newParentUri,
          updated_at: new Date().toISOString(),
        };
        await putItem(newItem);
      }
    }
  }

  // Step 2: Update vectors (delete old, put new with re-used embeddings)
  const existingVectors = await getVectors(allUris);
  for (const vec of existingVectors) {
    try {
      const newUri = rewriteUri(vec.key, from_uri, to_uri);
      const oldParent = vec.metadata.parent_uri as string;
      const newParentUri = oldParent && oldParent.startsWith(from_uri)
        ? rewriteUri(oldParent, from_uri, to_uri)
        : getParentUri(newUri) ?? oldParent;

      // Put new vector before deleting old — if putVector fails, the old
      // vector remains valid and the item stays searchable at the old URI.
      // If deleteVector fails after, we get a harmless stale duplicate.
      await putVector(
        newUri,
        newParentUri as string,
        vec.metadata.context_type as string,
        vec.metadata.level as number,
        vec.metadata.abstract as string,
        vec.data
      );
      await deleteVector(vec.key);
    } catch (error) {
      logger.warn('Vector update failed during mv, continuing', { key: vec.key, error });
    }
  }

  // Step 3: Delete old items
  const keys = allUris.flatMap((u) => [
    { uri: u, level: 0 },
    { uri: u, level: 1 },
    { uri: u, level: 2 },
  ]);
  await batchDeleteItems(keys);

  // Delete old S3 content
  for (const oldUri of allUris) {
    try {
      const l2Item = await getItem(oldUri, 2);
      if (l2Item?.s3_key) {
        await deleteS3Object(l2Item.s3_key);
      }
    } catch {
      // Not all items have S3 content -- skip silently
    }
  }

  metrics.addMetric('ChildCount', MetricUnit.Count, allUris.length);
  metrics.addMetric('FilesystemLatency', MetricUnit.Milliseconds, Date.now() - opStart);
  metrics.publishStoredMetrics();
  return ok({ status: 'ok', moved: allUris.length });
}
