import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  transactWriteItems,
  acquireProcessingLock,
  resetProcessingStatus,
} from './dynamodb';
import { summariseDocument, generateEmbedding } from './bedrock';
import { putL2Content } from './s3';
import { putVector, awaitVectorVisibility } from './s3-vectors';
import { enqueueRollup } from './sqs';
import { getParentUri, parseUri } from '../utils/uri';
import type { ContextType, ContextItem } from '../types/context';
import { SHORT_CONTENT_TOKEN_THRESHOLD } from '../../lib/config';

const logger = new Logger({ serviceName: 'vcs-write-pipeline' });
const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-write-pipeline' });

/**
 * Scope-to-ContextType mapping for URI inference.
 */
const SCOPE_TO_CONTEXT_TYPE: Record<string, ContextType> = {
  resources: 'resource',
  user: 'memory',
  agent: 'skill',
  session: 'session',
  wiki: 'wiki',
  schema: 'schema',
  log: 'log',
};

export interface WriteDocumentInput {
  /** Full leaf URI (e.g. viking://resources/docs/hello.md) */
  uri: string;
  /** Raw UTF-8 content to ingest */
  content: string;
  /** Optional Bedrock summarisation instruction */
  instruction?: string;
  /**
   * Whether to throw if the write lock cannot be acquired (default: true).
   * Set to false for fire-and-forget callers that tolerate skipping.
   */
  requireLock?: boolean;
}

export interface WriteDocumentResult {
  uri: string;
  processingStatus: 'ready' | 'indexing';
  lockAcquired: boolean;
}

/**
 * Returns true if the error is transient and safe to retry.
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = (error as { name?: string }).name ?? '';
  if (
    name === 'ThrottlingException' ||
    name === 'ProvisionedThroughputExceededException' ||
    name === 'ServiceUnavailableException' ||
    name === 'InternalServerError'
  ) {
    return true;
  }
  // S3 / Bedrock 5xx
  const httpStatus = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (httpStatus !== undefined && httpStatus >= 500) return true;
  return false;
}

/**
 * Unified write pipeline: summarise, embed, store, rollup.
 *
 * Extracts the common ingestion logic from the ingestion handler so that
 * multiple entry points (API ingestion, future compile Lambda, CLI bulk-ingest)
 * share the same pipeline without duplicating 80 lines of orchestration.
 *
 * @returns WriteDocumentResult with processing status
 * @throws if any pipeline step fails (caller should handle reset)
 */
export async function writeDocument(input: WriteDocumentInput): Promise<WriteDocumentResult> {
  const { uri, content, instruction, requireLock = true } = input;

  // Acquire processing lock
  const lockAcquired = await acquireProcessingLock(uri);
  if (!lockAcquired) {
    if (requireLock) {
      throw new Error(`Could not acquire write lock for ${uri}`);
    }
    return { uri, processingStatus: 'ready', lockAcquired: false };
  }

  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [1000, 2000, 4000];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Store L2 full content in S3
      const s3Key = `l2/${uri.replace('viking://', '')}`;
      await putL2Content(s3Key, content);

      // Summarise document via Bedrock (skip for short content)
      const estimatedTokens = Math.ceil(content.length / 4);
      const summary = estimatedTokens <= SHORT_CONTENT_TOKEN_THRESHOLD
        ? { abstract: content, sections: [{ title: 'Content', summary: content }] }
        : await summariseDocument(content, instruction);

      // Determine parent URI and context type
      const parentUri = getParentUri(uri) ?? 'viking://';
      const parsedUri = parseUri(uri);
      const contextType: ContextType = SCOPE_TO_CONTEXT_TYPE[parsedUri.scope] ?? 'resource';
      const now = new Date().toISOString();

      // Base item shared across L0/L1/L2
      const baseItem: Omit<ContextItem, 'level' | 'content' | 's3_key'> = {
        uri,
        parent_uri: parentUri,
        context_type: contextType,
        is_directory: false,
        processing_status: 'ready',
        created_at: now,
        updated_at: now,
      };

      // Write L0 (abstract), L1 (sections), L2 (S3 ref) — atomic transaction
      await transactWriteItems([
        { ...baseItem, level: 0, content: summary.abstract } as ContextItem,
        { ...baseItem, level: 1, content: JSON.stringify(summary.sections) } as ContextItem,
        { ...baseItem, level: 2, s3_key: s3Key } as ContextItem,
      ]);

      // Generate embedding from L0 abstract + L1 section titles/summaries
      const embeddingText = `${summary.abstract}\n\n${summary.sections.map((s) => `${s.title}: ${s.summary}`).join('\n')}`;
      // Truncate to 30000 chars (~7500 tokens) to prevent Titan V2 8K token limit errors
      const MAX_EMBEDDING_CHARS = 30000;
      if (embeddingText.length > MAX_EMBEDDING_CHARS) {
        logger.warn('Embedding text truncated', { uri, originalLength: embeddingText.length, truncatedTo: MAX_EMBEDDING_CHARS });
      }
      const truncatedEmbeddingText = embeddingText.length > MAX_EMBEDDING_CHARS
        ? embeddingText.slice(0, MAX_EMBEDDING_CHARS)
        : embeddingText;
      const embedding = await generateEmbedding(truncatedEmbeddingText);

      // Store vector (PutVectors overwrites by key)
      await putVector(uri, parentUri, contextType, 0, summary.abstract, embedding);

      // Verify vector is discoverable in ANN index
      const visibility = await awaitVectorVisibility(uri, embedding);

      if (!visibility.visible) {
        logger.warn('ANN index visibility not confirmed -- content persisted, search will converge', {
          uri, attempts: visibility.attempts,
        });
      }

      if (parentUri !== 'viking://') {
        await enqueueRollup(parentUri);
      }

      return {
        uri,
        processingStatus: visibility.visible ? 'ready' : 'indexing',
        lockAcquired: true,
      };
    } catch (error) {
      const retryable = isRetryableError(error);
      if (retryable && attempt < MAX_ATTEMPTS) {
        const delayMs = RETRY_DELAYS_MS[attempt - 1] ?? 1000;
        logger.warn('Write pipeline transient error — retrying', {
          uri, attempt, delayMs, error: (error as Error).message,
        });
        metrics.addMetric('WriteDocumentRetry', MetricUnit.Count, 1);
        metrics.publishStoredMetrics();
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      // Non-retryable error or final attempt — reset lock and throw
      logger.error('Write pipeline failed', { error: error as Error, uri, attempt });
      await resetProcessingStatus(uri, 'pending');
      throw error;
    }
  }

  // Should never reach here — loop always returns or throws
  throw new Error(`Write pipeline exhausted retries for ${uri}`);
}
