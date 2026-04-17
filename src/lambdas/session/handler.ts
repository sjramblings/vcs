import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { SSM_PATHS, HANDLER_PARAMS } from '../../../lib/config';
import { loadAllParams, getParam } from '../../services/ssm';
import {
  initDynamoDB,
  initSessionsDB,
  putSessionEntry,
  getSessionMeta,
  getAllSessionMessages,
  updateSessionStatus,
  incrementActiveCount,
  incrementMsgCount,
  deleteSessionEntries,
  setSessionTTL,
  putItem,
} from '../../services/dynamodb';
import {
  initBedrock,
  summariseSession,
  generateEmbedding,
} from '../../services/bedrock';
import { initS3, archiveSession } from '../../services/s3';
import { initS3Vectors, putVector, deleteVector } from '../../services/s3-vectors';
import { initSqs, enqueueRollup } from '../../services/sqs';
import {
  createSessionSchema,
  addMessageSchema,
  usedSchema,
} from '../../utils/validators';
import {
  ok,
  created,
  badRequest,
  notFound,
  fromError,
} from '../../utils/response';
import type { SessionEntry } from '../../types/session';
import type { ContextItem } from '../../types/context';

const logger = new Logger({ serviceName: 'vcs-session' });
const tracer = new Tracer({ serviceName: 'vcs-session' });
const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-session' });
let initialized = false;

/**
 * Session Lambda handler.
 * Routes: POST /sessions, POST /sessions/{id}/messages,
 *         POST /sessions/{id}/used, POST /sessions/{id}/commit
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
      await loadAllParams(HANDLER_PARAMS.session);
      const tableName = await getParam(SSM_PATHS.CONTEXT_TABLE_NAME);
      const sessionsTableName = await getParam(SSM_PATHS.SESSIONS_TABLE_NAME);
      const contentBucket = await getParam(SSM_PATHS.CONTENT_BUCKET_NAME);
      const vectorBucket = await getParam(SSM_PATHS.VECTOR_BUCKET_NAME);
      const vectorIndex = await getParam(SSM_PATHS.VECTOR_INDEX_NAME);
      const queueUrl = await getParam(SSM_PATHS.ROLLUP_QUEUE_URL);
      initDynamoDB(tableName);
      initSessionsDB(sessionsTableName);
      initS3(contentBucket);
      initS3Vectors(vectorBucket, vectorIndex);
      initBedrock();
      initSqs(queueUrl);
      initialized = true;
    }

    const { httpMethod, resource, pathParameters, body } = event;

    let result: APIGatewayProxyResult;

    if (httpMethod === 'POST' && resource === '/sessions')
      result = await handleCreate(body);
    else if (httpMethod === 'POST' && resource === '/sessions/{id}/messages')
      result = await handleAddMessage(pathParameters?.id, body);
    else if (httpMethod === 'POST' && resource === '/sessions/{id}/used')
      result = await handleUsed(pathParameters?.id, body);
    else if (httpMethod === 'POST' && resource === '/sessions/{id}/commit')
      result = await handleCommit(pathParameters?.id);
    else if (httpMethod === 'DELETE' && resource === '/sessions/{id}')
      result = await handleDelete(pathParameters?.id);
    else
      result = notFound('Endpoint not found');

    tracer.addResponseAsMetadata(result, 'handler');
    return result;
  } catch (error) {
    tracer.addErrorAsMetadata(error as Error);
    logger.error('Session operation failed', { error: error as Error });
    return fromError(error);
  } finally {
    subsegment?.close();
    if (segment) tracer.setSegment(segment);
  }
};

/**
 * POST /sessions -- Create a new session with a epoch-millis session_id.
 */
async function handleCreate(
  body: string | null
): Promise<APIGatewayProxyResult> {
  let parsedBody: unknown;
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch {
    return badRequest('Invalid JSON body');
  }

  const parsed = createSessionSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  const sessionId = randomUUID();
  const now = new Date().toISOString();

  const entry: SessionEntry = {
    session_id: sessionId,
    entry_type_seq: 'meta#0',
    status: 'active',
    timestamp: now,
    compression_summary: '',
    msg_count: 0,
  };

  await putSessionEntry(entry);

  metrics.addDimension('Operation', 'create');
  metrics.publishStoredMetrics();

  return created({ session_id: sessionId, status: 'active' });
}

/**
 * POST /sessions/{id}/messages -- Add a structured message to the session.
 * Uses atomic msg_count increment for sequence numbering.
 */
async function handleAddMessage(
  sessionId: string | undefined,
  body: string | null
): Promise<APIGatewayProxyResult> {
  if (!sessionId) {
    return badRequest('Missing session ID');
  }

  let parsedBody: unknown;
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch {
    return badRequest('Invalid JSON body');
  }

  const parsed = addMessageSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  // Check session exists
  const meta = await getSessionMeta(sessionId);
  if (!meta) {
    return notFound('Session not found');
  }

  // Atomic increment to get sequence number
  const seq = await incrementMsgCount(sessionId);

  const entry: SessionEntry = {
    session_id: sessionId,
    entry_type_seq: `msg#${seq}`,
    role: parsed.data.role,
    parts: parsed.data.parts,
    timestamp: new Date().toISOString(),
  };

  await putSessionEntry(entry);

  metrics.addDimension('Operation', 'message');
  metrics.publishStoredMetrics();

  return ok({ sequence: seq });
}

/**
 * POST /sessions/{id}/used -- Record context usage in a session.
 * Increments active_count on each referenced URI in the context table.
 */
async function handleUsed(
  sessionId: string | undefined,
  body: string | null
): Promise<APIGatewayProxyResult> {
  if (!sessionId) {
    return badRequest('Missing session ID');
  }

  let parsedBody: unknown;
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch {
    return badRequest('Invalid JSON body');
  }

  const parsed = usedSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return badRequest('Invalid request', parsed.error.issues);
  }

  // Check session exists
  const meta = await getSessionMeta(sessionId);
  if (!meta) {
    return notFound('Session not found');
  }

  // Increment active_count on each URI
  for (const uri of parsed.data.uris) {
    await incrementActiveCount(uri);
  }

  // Atomic increment to get sequence number for used entry
  const seq = await incrementMsgCount(sessionId);

  const entry: SessionEntry = {
    session_id: sessionId,
    entry_type_seq: `used#${seq}`,
    uris: parsed.data.uris,
    skill: parsed.data.skill,
    timestamp: new Date().toISOString(),
  };

  await putSessionEntry(entry);

  metrics.addDimension('Operation', 'used');
  metrics.publishStoredMetrics();

  return ok({ recorded: parsed.data.uris.length });
}

/**
 * POST /sessions/{id}/commit -- Archive session and write session node.
 * Archives messages + summary to S3, writes session L0/L1/vector, enqueues
 * session directory rollup. Memory extraction from sessions is intentionally
 * deferred to a follow-up milestone per the v1-stable subtraction plan —
 * see MILESTONE.md.
 */
async function handleCommit(
  sessionId: string | undefined
): Promise<APIGatewayProxyResult> {
  if (!sessionId) {
    return badRequest('Missing session ID');
  }

  // Guard: check session exists and status
  const meta = await getSessionMeta(sessionId);
  if (!meta) {
    return notFound('Session not found');
  }
  if (meta.status === 'committed') {
    return ok({ status: 'already_committed', session_uri: `viking://session/${sessionId}/` });
  }

  metrics.addDimension('Operation', 'commit');
  const commitStart = Date.now();

  // Read all messages
  const messages = await getAllSessionMessages(sessionId);
  const messagesText = formatMessagesForLLM(messages);

  metrics.addMetric('MessageCount', MetricUnit.Count, messages.length);

  // === PHASE 1: Archive ===

  // 1a. Generate session summary via Bedrock
  const summaryStart = Date.now();
  const summary = await summariseSession(messagesText);
  metrics.addMetric('SessionSummaryLatency', MetricUnit.Milliseconds, Date.now() - summaryStart);

  // 1b. Archive to S3
  await archiveSession(sessionId, messages, summary);

  // 1c. Write session L0/L1 to context table at viking://session/{sessionId}/
  const sessionUri = `viking://session/${sessionId}/`;
  const parentUri = 'viking://session/';
  const now = new Date().toISOString();

  // L0: one_line abstract
  await putItem({
    uri: sessionUri,
    level: 0,
    parent_uri: parentUri,
    context_type: 'session',
    is_directory: false,
    processing_status: 'ready',
    content: summary.one_line,
    created_at: now,
    updated_at: now,
  } as ContextItem);

  // L1: full analysis
  const l1Content = `${summary.analysis}\n\nKey concepts: ${summary.key_concepts.join(', ')}\n\nPending tasks: ${summary.pending_tasks.join(', ')}`;
  await putItem({
    uri: sessionUri,
    level: 1,
    parent_uri: parentUri,
    context_type: 'session',
    is_directory: false,
    processing_status: 'ready',
    content: l1Content,
    created_at: now,
    updated_at: now,
  } as ContextItem);

  // 1d. Generate embedding and write vector for session node
  const sessionEmbedding = await generateEmbedding(`${summary.one_line} ${summary.analysis}`);
  // Idempotent: deleteVector before putVector (per established pattern)
  await deleteVector(sessionUri);
  await putVector(sessionUri, parentUri, 'session', 0, summary.one_line, sessionEmbedding);

  // Mark session as committed (atomic status transition)
  await updateSessionStatus(sessionId, 'committed');

  // Set TTL on all session items (30 days from commit)
  await setSessionTTL(sessionId);

  // Enqueue session directory rollup
  await enqueueRollup('viking://session/');

  metrics.addMetric('SessionCommitLatency', MetricUnit.Milliseconds, Date.now() - commitStart);
  metrics.publishStoredMetrics();

  return ok({
    status: 'ok',
    session_uri: sessionUri,
  });
}

/**
 * DELETE /sessions/{id} -- Delete all session entries.
 */
async function handleDelete(
  sessionId: string | undefined
): Promise<APIGatewayProxyResult> {
  if (!sessionId) return badRequest('Missing session ID');

  const meta = await getSessionMeta(sessionId);
  if (!meta) return notFound('Session not found');

  const deleted = await deleteSessionEntries(sessionId);

  metrics.addDimension('Operation', 'delete');
  metrics.publishStoredMetrics();

  return ok({ status: 'deleted', deleted });
}

/**
 * Formats session messages for LLM input.
 * Extracts only text parts, joining as "role: content" lines.
 */
function formatMessagesForLLM(messages: SessionEntry[]): string {
  return messages
    .map((msg) => {
      const textParts = (msg.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.content)
        .join(' ');
      return `${msg.role ?? 'unknown'}: ${textParts}`;
    })
    .join('\n');
}
