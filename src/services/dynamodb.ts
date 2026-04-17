import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb';

type BatchRequestItems = NonNullable<BatchWriteCommandInput['RequestItems']>;
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { ContextItem } from '../types/context';
import type { SessionEntry, SessionStatus } from '../types/session';
import { NotFoundError } from '../utils/errors';
import { getParentUri } from '../utils/uri';

const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-dynamodb' });

const rawClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

let tableName: string;
let sessionsTableName: string;

/**
 * Initialises the DynamoDB service with the context table name.
 * Must be called before any other functions.
 */
export function initDynamoDB(name: string): void {
  tableName = name;
}

/**
 * Initialises the sessions table name for session context reads.
 * Must be called before getSessionContext.
 */
export function initSessionsDB(name: string): void {
  sessionsTableName = name;
}

/**
 * Queries children of a parent URI using the parent-index GSI.
 * Returns level-0 items only (one item per child, not all 3 levels).
 * Supports cursor-based pagination via nextToken.
 */
export async function queryChildren(
  parentUri: string,
  options?: { limit?: number; nextToken?: string }
): Promise<{ items: ContextItem[]; nextToken?: string }> {
  const limit = options?.limit ?? 50;

  let exclusiveStartKey: Record<string, unknown> | undefined;
  if (options?.nextToken) {
    try {
      exclusiveStartKey = JSON.parse(
        Buffer.from(options.nextToken, 'base64').toString('utf-8')
      );
    } catch {
      throw new Error('Invalid nextToken');
    }
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'parent-index',
      KeyConditionExpression: 'parent_uri = :parentUri',
      FilterExpression: '#lvl = :zero',
      ExpressionAttributeNames: { '#lvl': 'level' },
      ExpressionAttributeValues: {
        ':parentUri': parentUri,
        ':zero': 0,
      },
      Limit: limit,
      ...(exclusiveStartKey
        ? { ExclusiveStartKey: exclusiveStartKey }
        : {}),
    })
  );

  let nextToken: string | undefined;
  if (result.LastEvaluatedKey) {
    nextToken = Buffer.from(
      JSON.stringify(result.LastEvaluatedKey)
    ).toString('base64');
  }

  return {
    items: (result.Items ?? []) as ContextItem[],
    nextToken,
  };
}

/**
 * Gets a single item by URI (partition key) and level (sort key).
 */
export async function getItem(
  uri: string,
  level: number
): Promise<ContextItem | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { uri, level },
    })
  );

  return (result.Item as ContextItem) ?? null;
}

/**
 * Puts an item into the context table (unconditional write).
 */
export async function putItem(item: ContextItem): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

/**
 * Writes multiple items atomically using DynamoDB TransactWriteItems.
 * Used by write-pipeline for atomic L0/L1/L2 writes.
 * If any Put fails, the entire transaction is rolled back.
 */
export async function transactWriteItems(
  items: ContextItem[]
): Promise<void> {
  await docClient.send(
    new TransactWriteCommand({
      TransactItems: items.map((item) => ({
        Put: {
          TableName: tableName,
          Item: item,
        },
      })),
    })
  );
}

/**
 * Puts an item only if it does not already exist (conditional write).
 * Returns true if the item was created, false if it already exists.
 */
export async function putItemIfNotExists(
  item: ContextItem
): Promise<boolean> {
  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(uri)',
      })
    );
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === 'ConditionalCheckFailedException'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Acquires a processing lock by setting processing_status to 'processing'.
 * Uses a conditional update to reject if already processing (prevents concurrent ingestion).
 * Automatically overrides stale locks older than 5 minutes.
 * Returns true if the lock was acquired, false if another ingestion is in flight.
 */
export async function acquireProcessingLock(uri: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // Pre-check for stale lock: read current item before acquiring
  const existing = await docClient.send(new GetCommand({ TableName: tableName, Key: { uri, level: 0 } }));
  const isStale =
    existing.Item?.processing_status === 'processing' &&
    existing.Item?.lock_acquired_at != null &&
    (existing.Item.lock_acquired_at as string) < staleThreshold;

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { uri, level: 0 },
        UpdateExpression: 'SET processing_status = :processing, updated_at = :now, lock_acquired_at = :now',
        ConditionExpression: 'attribute_not_exists(uri) OR processing_status <> :processing OR lock_acquired_at < :staleThreshold',
        ExpressionAttributeValues: {
          ':processing': 'processing',
          ':now': now,
          ':staleThreshold': staleThreshold,
        },
      })
    );

    // Emit stale lock override metric if we broke a stale lock
    if (isStale) {
      metrics.addMetric('StaleLockOverride', MetricUnit.Count, 1);
      metrics.publishStoredMetrics();
    }

    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === 'ConditionalCheckFailedException'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Resets the processing_status for a given URI.
 * Used to release the processing lock on success ('ready') or failure ('pending').
 */
export async function resetProcessingStatus(
  uri: string,
  status: 'pending' | 'ready'
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { uri, level: 0 },
      UpdateExpression: 'SET processing_status = :status, updated_at = :now',
      ExpressionAttributeValues: {
        ':status': status,
        ':now': new Date().toISOString(),
      },
    })
  );
}

export interface QueryReadyChildrenOptions {
  /** Maximum number of items to return. If omitted, returns all ready children. */
  limit?: number;
}

/**
 * Queries children of a parent URI with processing_status = 'ready'.
 * Accepts an optional { limit } cap used by map-reduce rollup to
 * bound the number of children fetched per invocation.
 *
 * Returns only { uri, content, context_type } projected fields. Other
 * ContextItem fields will be undefined.
 *
 * When options.limit is provided:
 * - `Limit` is passed to each underlying QueryCommand
 * - Pagination stops as soon as items.length >= options.limit
 * - The returned array is truncated to exactly options.limit items
 *
 * When options.limit is undefined, the original pagination behaviour is
 * preserved (loop until LastEvaluatedKey is undefined).
 */
export async function queryReadyChildren(
  parentUri: string,
  options: QueryReadyChildrenOptions = {}
): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'parent-index',
        KeyConditionExpression: 'parent_uri = :parentUri',
        FilterExpression: '#lvl = :zero AND processing_status = :ready',
        ExpressionAttributeNames: {
          '#lvl': 'level',
          '#ct': 'content',
          '#ctx': 'context_type',
        },
        ExpressionAttributeValues: {
          ':parentUri': parentUri,
          ':zero': 0,
          ':ready': 'ready',
        },
        ProjectionExpression: 'uri, #ct, #ctx',
        ...(options.limit !== undefined ? { Limit: options.limit } : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );

    items.push(...((result.Items ?? []) as ContextItem[]));

    // Stop paginating early if the caller-provided cap has been reached.
    if (options.limit !== undefined && items.length >= options.limit) {
      break;
    }

    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  // Defensive truncation — DynamoDB may return slightly more than Limit after
  // post-filter accounting, so slice to exact caller cap.
  if (options.limit !== undefined && items.length > options.limit) {
    return items.slice(0, options.limit);
  }

  return items;
}

/**
 * Queries children of a parent URI whose updated_at is strictly after the given
 * ISO timestamp. Scaffolding for delta rollups. Projects the same
 * fields as queryReadyChildren plus updated_at for uniform handling. Filters on
 * processing_status='ready' AND updated_at > :since.
 *
 * @param parentUri parent directory URI (e.g. 'viking://resources/docs/')
 * @param sinceTimestamp ISO-8601 string — the boundary is exclusive (strictly >)
 */
export async function queryChildrenSince(
  parentUri: string,
  sinceTimestamp: string
): Promise<ContextItem[]> {
  const items: ContextItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'parent-index',
        KeyConditionExpression: 'parent_uri = :parentUri',
        FilterExpression:
          '#lvl = :zero AND processing_status = :ready AND updated_at > :since',
        ExpressionAttributeNames: {
          '#lvl': 'level',
          '#ct': 'content',
          '#ctx': 'context_type',
          '#ua': 'updated_at',
        },
        ExpressionAttributeValues: {
          ':parentUri': parentUri,
          ':zero': 0,
          ':ready': 'ready',
          ':since': sinceTimestamp,
        },
        ProjectionExpression: 'uri, #ct, #ctx, #ua',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );

    items.push(...((result.Items ?? []) as ContextItem[]));
    exclusiveStartKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  return items;
}

/**
 * Checks whether the per-parent rollup cooldown has elapsed. Read-only —
 * does NOT write anything. The actual `last_rolled_up_at` marker is set
 * by the parent-summariser handler's putItem after all side effects
 * (Bedrock, DynamoDB L0/L1, vector) succeed, so a crash before
 * completion never consumes the cooldown.
 *
 * SQS FIFO MessageGroupId serialises per-parent delivery, so no
 * concurrent handler can race between this read and the eventual write.
 *
 * Returns true if the cooldown has elapsed (or the parent has never been
 * rolled up), false if the handler should skip.
 */
export async function checkCooldown(
  parentUri: string,
  cooldownSec: number
): Promise<boolean> {
  const cooldownThreshold = new Date(Date.now() - cooldownSec * 1000).toISOString();

  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { uri: parentUri, level: 0 },
      ProjectionExpression: 'last_rolled_up_at',
    })
  );

  const lastRolledUpAt = result.Item?.last_rolled_up_at as string | undefined;
  if (!lastRolledUpAt) return true; // never rolled up — proceed
  return lastRolledUpAt < cooldownThreshold;
}

/**
 * Reads session context: compression_summary from meta#0 and last 5 messages.
 * Throws NotFoundError if the session does not exist (meta#0 not found).
 */
export async function getSessionContext(
  sessionId: string
): Promise<{ summary: string; messages: Array<{ role: string; content: string }> }> {
  // Read meta#0 for compression_summary
  const meta = await docClient.send(
    new GetCommand({
      TableName: sessionsTableName,
      Key: { session_id: sessionId, entry_type_seq: 'meta#0' },
    })
  );

  if (!meta.Item) {
    throw new NotFoundError('Session not found');
  }

  // Read last 5 messages (newest first)
  const messagesResult = await docClient.send(
    new QueryCommand({
      TableName: sessionsTableName,
      KeyConditionExpression: 'session_id = :sid AND begins_with(entry_type_seq, :prefix)',
      ExpressionAttributeValues: {
        ':sid': sessionId,
        ':prefix': 'msg#',
      },
      ScanIndexForward: false,
      Limit: 5,
    })
  );

  const messages = (messagesResult.Items ?? []).map((item) => ({
    role: item.role as string,
    content: Array.isArray(item.parts)
      ? (item.parts as Array<{ type: string; content?: string }>)
          .filter((p) => p.type === 'text' && p.content)
          .map((p) => p.content)
          .join(' ')
      : (item.content as string) ?? '',
  }));

  return {
    summary: (meta.Item.compression_summary as string) ?? '',
    messages,
  };
}

// ── Session write helpers ──

/**
 * Writes a session entry (message or meta) to the sessions table.
 */
export async function putSessionEntry(entry: SessionEntry): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: sessionsTableName,
      Item: entry,
    })
  );
}

/**
 * Reads the meta#0 entry for a session. Returns null if not found.
 */
export async function getSessionMeta(sessionId: string): Promise<SessionEntry | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: sessionsTableName,
      Key: { session_id: sessionId, entry_type_seq: 'meta#0' },
    })
  );

  return (result.Item as SessionEntry) ?? null;
}

/**
 * Queries all message entries for a session, ordered by sequence.
 * Paginates until all items are retrieved.
 */
export async function getAllSessionMessages(sessionId: string): Promise<SessionEntry[]> {
  const items: SessionEntry[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: sessionsTableName,
        KeyConditionExpression: 'session_id = :sid AND begins_with(entry_type_seq, :prefix)',
        ExpressionAttributeValues: {
          ':sid': sessionId,
          ':prefix': 'msg#',
        },
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );

    items.push(...((result.Items ?? []) as SessionEntry[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return items;
}

/**
 * Conditionally updates session status from 'active' to the target status.
 * Returns true if updated, false if the session was already committed/archived.
 */
export async function updateSessionStatus(sessionId: string, status: SessionStatus): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: sessionsTableName,
        Key: { session_id: sessionId, entry_type_seq: 'meta#0' },
        UpdateExpression: 'SET #status = :newStatus, updated_at = :now',
        ConditionExpression: '#status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':newStatus': status,
          ':active': 'active',
          ':now': new Date().toISOString(),
        },
      })
    );
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === 'ConditionalCheckFailedException'
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Atomically increments msg_count on a session's meta#0 entry.
 * Returns the new msg_count value (used as sequence number).
 */
export async function incrementMsgCount(sessionId: string): Promise<number> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: sessionsTableName,
      Key: { session_id: sessionId, entry_type_seq: 'meta#0' },
      UpdateExpression: 'ADD msg_count :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    })
  );

  return (result.Attributes?.msg_count as number) ?? 0;
}

/**
 * Deletes ALL entries for a session (meta, messages, used) from the sessions table.
 * Queries all items by session_id (no SK filter), then batch-deletes in chunks of 25.
 * Returns the total count of deleted entries.
 */
export async function deleteSessionEntries(sessionId: string): Promise<number> {
  // Query all entries for this session (paginated)
  const keys: Array<{ session_id: string; entry_type_seq: string }> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: sessionsTableName,
        KeyConditionExpression: 'session_id = :sid',
        ExpressionAttributeValues: { ':sid': sessionId },
        ProjectionExpression: 'session_id, entry_type_seq',
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );

    for (const item of result.Items ?? []) {
      keys.push({
        session_id: item.session_id as string,
        entry_type_seq: item.entry_type_seq as string,
      });
    }
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  if (keys.length === 0) return 0;

  // Batch delete in chunks of 25
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    let requestItems: BatchRequestItems = {
      [sessionsTableName]: batch.map((k) => ({
        DeleteRequest: { Key: { session_id: k.session_id, entry_type_seq: k.entry_type_seq } },
      })),
    };

    let retries = 0;
    while (Object.keys(requestItems).length > 0 && retries < 5) {
      const result = await docClient.send(
        new BatchWriteCommand({ RequestItems: requestItems })
      );

      const unprocessed = result.UnprocessedItems;
      if (unprocessed && Object.keys(unprocessed).length > 0) {
        requestItems = unprocessed as BatchRequestItems;
        retries++;
        await new Promise((resolve) => setTimeout(resolve, 100 * retries));
      } else {
        break;
      }
    }
  }

  return keys.length;
}

/**
 * Sets TTL on all items for a committed session (30 days from now).
 * DynamoDB TTL requires the attribute on each item individually.
 */
export async function setSessionTTL(sessionId: string): Promise<number> {
  const ttl = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);
  const items: Array<Record<string, unknown>> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: sessionsTableName,
        KeyConditionExpression: 'session_id = :sid',
        ExpressionAttributeValues: { ':sid': sessionId },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      })
    );
    items.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  if (items.length === 0) return 0;

  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    let requestItems: BatchRequestItems = {
      [sessionsTableName]: batch.map((item) => ({
        PutRequest: {
          Item: { ...item, ttl },
        },
      })),
    };
    let retries = 0;

    while (Object.keys(requestItems).length > 0 && retries < 5) {
      const result = await docClient.send(
        new BatchWriteCommand({ RequestItems: requestItems })
      );

      const unprocessed = result.UnprocessedItems;
      if (unprocessed && Object.keys(unprocessed).length > 0) {
        requestItems = unprocessed as BatchRequestItems;
        retries++;
        await new Promise((resolve) => setTimeout(resolve, 100 * retries));
      } else {
        break;
      }
    }
  }

  return items.length;
}

/**
 * Atomically increments the active_count on a context item.
 * Used to track how many sessions reference a resource.
 */
export async function incrementActiveCount(uri: string): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { uri, level: 0 },
      UpdateExpression: 'ADD active_count :one SET updated_at = :now',
      ExpressionAttributeValues: {
        ':one': 1,
        ':now': new Date().toISOString(),
      },
    })
  );
}

/**
 * Batch-deletes items from the context table in chunks of 25.
 * Retries UnprocessedItems with 100ms backoff.
 */
export async function batchDeleteItems(
  keys: Array<{ uri: string; level: number }>
): Promise<void> {
  // Process in chunks of 25 (DynamoDB BatchWriteItem limit)
  for (let i = 0; i < keys.length; i += 25) {
    const batch = keys.slice(i, i + 25);
    let requestItems: BatchRequestItems = {
      [tableName]: batch.map((k) => ({
        DeleteRequest: { Key: { uri: k.uri, level: k.level } },
      })),
    };

    let retries = 0;
    while (Object.keys(requestItems).length > 0 && retries < 5) {
      const result = await docClient.send(
        new BatchWriteCommand({ RequestItems: requestItems })
      );

      const unprocessed = result.UnprocessedItems;
      if (unprocessed && Object.keys(unprocessed).length > 0) {
        requestItems = unprocessed as BatchRequestItems;
        retries++;
        await new Promise((resolve) => setTimeout(resolve, 100 * retries));
      } else {
        break;
      }
    }
  }
}

/**
 * Deletes a single item from the context table.
 */
export async function deleteItem(uri: string, level: number): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { uri, level },
    })
  );
}
