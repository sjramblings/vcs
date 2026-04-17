/** SSM parameter paths for cross-construct value discovery. */
export const SSM_PATHS = {
  CONTEXT_TABLE_NAME: '/vcs/data/context-table-name',
  SESSIONS_TABLE_NAME: '/vcs/data/sessions-table-name',
  CONTENT_BUCKET_NAME: '/vcs/data/content-bucket-name',
  VECTOR_BUCKET_NAME: '/vcs/data/vector-bucket-name',
  VECTOR_INDEX_NAME: '/vcs/data/vector-index-name',
  ROLLUP_QUEUE_URL: '/vcs/compute/rollup-queue-url',
  ROLLUP_DLQ_URL: '/vcs/compute/rollup-dlq-url',
} as const;

/** SSM parameter subsets per Lambda handler. Only load what you need. */
export const HANDLER_PARAMS = {
  ingestion: [
    SSM_PATHS.CONTEXT_TABLE_NAME,
    SSM_PATHS.CONTENT_BUCKET_NAME,
    SSM_PATHS.VECTOR_BUCKET_NAME,
    SSM_PATHS.VECTOR_INDEX_NAME,
    SSM_PATHS.ROLLUP_QUEUE_URL,
  ],
  query: [
    SSM_PATHS.CONTEXT_TABLE_NAME,
    SSM_PATHS.SESSIONS_TABLE_NAME,
    SSM_PATHS.VECTOR_BUCKET_NAME,
    SSM_PATHS.VECTOR_INDEX_NAME,
  ],
  session: [
    SSM_PATHS.CONTEXT_TABLE_NAME,
    SSM_PATHS.SESSIONS_TABLE_NAME,
    SSM_PATHS.CONTENT_BUCKET_NAME,
    SSM_PATHS.VECTOR_BUCKET_NAME,
    SSM_PATHS.VECTOR_INDEX_NAME,
    SSM_PATHS.ROLLUP_QUEUE_URL,
  ],
  filesystem: [
    SSM_PATHS.CONTEXT_TABLE_NAME,
    SSM_PATHS.CONTENT_BUCKET_NAME,
    SSM_PATHS.VECTOR_BUCKET_NAME,
    SSM_PATHS.VECTOR_INDEX_NAME,
  ],
  parentSummariser: [
    SSM_PATHS.CONTEXT_TABLE_NAME,
    SSM_PATHS.VECTOR_BUCKET_NAME,
    SSM_PATHS.VECTOR_INDEX_NAME,
    SSM_PATHS.ROLLUP_QUEUE_URL,
  ],
  vectors: [
    SSM_PATHS.VECTOR_BUCKET_NAME,
    SSM_PATHS.VECTOR_INDEX_NAME,
  ],
} as const;

export const TITAN_EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';

export const NOVA_MICRO_MODEL_ID = 'amazon.nova-micro-v1:0';
export const NOVA_LITE_MODEL_ID = 'amazon.nova-lite-v1:0';

/** Returns the Fast tier model ID (Nova Micro). No CRIP prefix -- Amazon models don't use it. */
export function getFastModelId(): string {
  return NOVA_MICRO_MODEL_ID;
}

/** Returns the Standard tier model ID (Nova Lite). No CRIP prefix -- Amazon models don't use it. */
export function getStandardModelId(): string {
  return NOVA_LITE_MODEL_ID;
}

/** Returns the Titan Embed model ID (no CRIP prefix needed). */
export function getTitanEmbedModelId(): string {
  return TITAN_EMBED_MODEL_ID;
}

export const VECTOR_DIMENSIONS = 1024;
export const VECTOR_DISTANCE_METRIC = 'cosine';
export const VECTOR_INDEX_NAME = 'vcs-embeddings';

export const VECTOR_VISIBILITY_MAX_ATTEMPTS = 5;
export const VECTOR_VISIBILITY_BASE_DELAY_MS = 100;  // ANN index rebuild is slower than point read

export const SHORT_CONTENT_TOKEN_THRESHOLD = 200;      // Skip Bedrock summarisation for content under this token count

// ── Rollup Correctness ──

/** Map-reduce trigger threshold. When queryReadyChildren returns more than this many
 *  items, parent-summariser chunks them into batches of this size for a reduce step. */
export const ROLLUP_FANOUT_BATCH = 32;

/** Maximum token budget for a parent L0 abstract after rollup. Validated against
 *  estimateTokens() from src/services/bedrock.ts; oversize abstracts are truncated. */
export const ROLLUP_MAX_ABSTRACT_TOKENS = 120;

/** Hard cap on rollup cascade depth. Worst case is MAX_URI_DEPTH - 1 = 9 given the
 *  URI depth cap of 10 in src/types/uri.ts. Used as a safety guard in 42-02. */
export const ROLLUP_MAX_DEPTH = 9;

// ── Rollup scheduling (v1-stable) ──

/** Per-parent rollup debounce window in seconds. parent-summariser's
 *  conditional UpdateItem rejects rollups whose last_rolled_up_at is newer
 *  than now - this value. Worst-case latency between a leaf write and its
 *  parent-level rollup visibility is bounded by SQS FIFO's 5-minute dedup
 *  window + this cooldown. CloudWatch alarm on ParentRollupLatency p99
 *  replaces the in-handler cost circuit-breaker. */
export const ROLLUP_COOLDOWN_SEC = 60;
