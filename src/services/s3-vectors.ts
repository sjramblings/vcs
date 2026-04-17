import {
  S3VectorsClient,
  PutVectorsCommand,
  DeleteVectorsCommand,
  QueryVectorsCommand,
  GetVectorsCommand,
  ListVectorsCommand,
} from '@aws-sdk/client-s3vectors';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { VECTOR_VISIBILITY_MAX_ATTEMPTS, VECTOR_VISIBILITY_BASE_DELAY_MS } from '../../lib/config';

const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-vectors' });

const client = new S3VectorsClient({});
let vectorBucketName: string;
let indexName: string;

/**
 * Initialises the S3 Vectors service with bucket and index names.
 * Must be called before any other functions.
 */
export function initS3Vectors(bucket: string, index: string): void {
  vectorBucketName = bucket;
  indexName = index;
}

/**
 * Writes a vector with metadata to S3 Vectors.
 * Metadata schema is immutable -- must match the index schema from Phase 1.
 *
 * Auto-filterable: uri, parent_uri, context_type, level
 * Non-filterable: abstract, created_at
 */
export async function putVector(
  uri: string,
  parentUri: string,
  contextType: string,
  level: number,
  abstract: string,
  embedding: number[]
): Promise<void> {
  await client.send(
    new PutVectorsCommand({
      vectorBucketName,
      indexName,
      vectors: [
        {
          key: uri,
          data: { float32: embedding },
          metadata: {
            uri,
            parent_uri: parentUri,
            context_type: contextType,
            level,
            abstract,
            created_at: new Date().toISOString(),
          },
        },
      ],
    })
  );
}

export interface VectorInput {
  uri: string;
  parentUri: string;
  contextType: string;
  level: number;
  abstract: string;
  embedding: number[];
}

export interface BatchResult {
  succeeded: number;
  failed: Array<{ uri: string; error: string }>;
}

/**
 * Writes multiple vectors in batched PutVectors API calls.
 * Splits into batches of 25 to stay within S3 Vectors capacity limits.
 * Continues through batch failures — returns which items succeeded/failed
 * so the caller knows what to retry.
 *
 * Use for bulk operations. For single real-time writes, use putVector().
 */
export async function putVectorBatch(vectors: VectorInput[]): Promise<BatchResult> {
  if (vectors.length === 0) return { succeeded: 0, failed: [] };

  const now = new Date().toISOString();
  const BATCH_SIZE = 25;
  let succeeded = 0;
  const failed: Array<{ uri: string; error: string }> = [];

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);

    try {
      await client.send(
        new PutVectorsCommand({
          vectorBucketName,
          indexName,
          vectors: batch.map((v) => ({
            key: v.uri,
            data: { float32: v.embedding },
            metadata: {
              uri: v.uri,
              parent_uri: v.parentUri,
              context_type: v.contextType,
              level: v.level,
              abstract: v.abstract,
              created_at: now,
            },
          })),
        })
      );
      succeeded += batch.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const v of batch) {
        failed.push({ uri: v.uri, error: message });
      }
    }
  }

  return { succeeded, failed };
}

/**
 * Deletes a vector by its key (URI) from S3 Vectors.
 */
export async function deleteVector(uri: string): Promise<void> {
  await client.send(
    new DeleteVectorsCommand({
      vectorBucketName,
      indexName,
      keys: [uri],
    })
  );
}

/**
 * Queries vectors by embedding similarity using S3 Vectors ANN search.
 * Returns results with key, distance, and metadata.
 * Optionally filters by metadata fields (e.g. context_type, parent_uri).
 */
export async function queryVectors(
  embedding: number[],
  topK: number,
  filter?: Record<string, unknown>
): Promise<Array<{ key: string; distance: number; metadata: Record<string, unknown> }>> {
  const start = Date.now();
  const result = await client.send(
    new QueryVectorsCommand({
      vectorBucketName,
      indexName,
      queryVector: { float32: embedding },
      topK,
      returnMetadata: true,
      returnDistance: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(filter ? { filter: filter as any } : {}),
    })
  );

  const results = (result.vectors ?? []).map((v) => ({
    key: v.key!,
    distance: v.distance!,
    metadata: v.metadata as Record<string, unknown>,
  }));

  metrics.addMetric('VectorQueryLatency', MetricUnit.Milliseconds, Date.now() - start);
  metrics.addMetric('VectorQueryResultCount', MetricUnit.Count, results.length);
  metrics.publishStoredMetrics();

  return results;
}

/**
 * Retrieves vectors by their keys from S3 Vectors.
 * Used during move operations to re-use existing embeddings.
 */
export async function getVectors(
  keys: string[]
): Promise<Array<{ key: string; data: number[]; metadata: Record<string, unknown> }>> {
  const result = await client.send(
    new GetVectorsCommand({
      vectorBucketName,
      indexName,
      keys,
    })
  );

  return (result.vectors ?? []).map((v) => ({
    key: v.key!,
    data: (v.data?.float32 ?? []) as number[],
    metadata: (v.metadata ?? {}) as Record<string, unknown>,
  }));
}

/**
 * Lists all vectors in the S3 Vectors index with their embeddings and metadata.
 * Paginates using ListVectorsCommand with returnData and returnMetadata enabled.
 * Optionally filters by URI prefix (client-side, since ListVectors has no prefix filter).
 */
export async function listAllVectors(
  scope?: string,
  limit = 500
): Promise<Array<{ uri: string; embedding: number[]; abstract: string; context_type: string }>> {
  const vectors: Array<{ uri: string; embedding: number[]; abstract: string; context_type: string }> = [];
  let nextToken: string | undefined;

  do {
    const maxResults = Math.min(limit - vectors.length, 100);
    const result = await client.send(
      new ListVectorsCommand({
        vectorBucketName,
        indexName,
        returnData: true,
        returnMetadata: true,
        maxResults,
        ...(nextToken ? { nextToken } : {}),
      })
    );

    for (const v of result.vectors ?? []) {
      const uri = v.key!;
      if (scope && !uri.startsWith(scope)) continue;

      vectors.push({
        uri,
        embedding: (v.data?.float32 ?? []) as number[],
        abstract: ((v.metadata as Record<string, unknown>)?.abstract as string) ?? '',
        context_type: ((v.metadata as Record<string, unknown>)?.context_type as string) ?? '',
      });

      if (vectors.length >= limit) break;
    }

    nextToken = result.nextToken;
  } while (nextToken && vectors.length < limit);

  return vectors;
}

export interface VisibilityResult {
  visible: boolean;
  attempts: number;
}

/**
 * Polls S3 Vectors ANN index until the given URI appears in query results.
 * Uses the same QueryVectorsCommand path that /search/find uses, ensuring
 * the vector is actually discoverable via similarity search — not just stored.
 *
 * Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms (5 attempts, ~3.1s worst case).
 *
 * Returns { visible: false } instead of throwing if the vector is not yet searchable.
 * The content is already persisted — eventual ANN consistency will make it searchable.
 */
export async function awaitVectorVisibility(
  uri: string,
  embedding: number[],
  maxAttempts = VECTOR_VISIBILITY_MAX_ATTEMPTS,
  baseDelayMs = VECTOR_VISIBILITY_BASE_DELAY_MS
): Promise<VisibilityResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Query the ANN index directly — skips queryVectors() to avoid inflating
    // VectorQueryLatency/VectorQueryResultCount metrics with internal polling calls.
    const result = await client.send(
      new QueryVectorsCommand({
        vectorBucketName,
        indexName,
        queryVector: { float32: embedding },
        topK: 1,
        returnMetadata: false,
        returnDistance: false,
        filter: { uri: { $eq: uri } },
      })
    );
    const vectors = result.vectors ?? [];
    if (vectors.length > 0 && vectors[0].key === uri) {
      return { visible: true, attempts: attempt };
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
    }
  }
  return { visible: false, attempts: maxAttempts };
}
