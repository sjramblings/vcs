import type {
  SQSEvent,
  SQSBatchResponse,
  SQSBatchItemFailure,
} from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import {
  SSM_PATHS,
  HANDLER_PARAMS,
  ROLLUP_FANOUT_BATCH,
  ROLLUP_MAX_ABSTRACT_TOKENS,
  ROLLUP_COOLDOWN_SEC,
  getFastModelId,
} from '../../../lib/config';
import { loadAllParams, getParam } from '../../services/ssm';
import {
  initDynamoDB,
  queryReadyChildren,
  putItem,
  checkCooldown,
} from '../../services/dynamodb';
import {
  summariseParent,
  generateEmbedding,
  converseRaw,
  estimateTokens,
  type SummarisationResult,
} from '../../services/bedrock';
import { initS3Vectors, putVector, awaitVectorVisibility } from '../../services/s3-vectors';
import { initSqs, enqueueRollup } from '../../services/sqs';
import { buildRollupReducePrompt } from '../../prompts/parent-rollup';
import { getParentUri, parseUri } from '../../utils/uri';
import type { ContextItem } from '../../types/context';

const logger = new Logger({ serviceName: 'vcs-parent-summariser' });
const tracer = new Tracer({ serviceName: 'vcs-parent-summariser' });
const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-parent-summariser' });
let initialized = false;

/**
 * Parent Summariser Lambda handler.
 * Triggered by SQS FIFO queue. Reads ready children, generates synthesised
 * L0/L1 for the parent directory, stores embedding, and propagates rollup
 * upward to grandparent.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const segment = tracer.getSegment();
  const subsegment = segment?.addNewSubsegment('## handler');
  if (subsegment) tracer.setSegment(subsegment);

  tracer.annotateColdStart();
  tracer.addServiceNameAnnotation();

  // collect per-record failures so SQS only retries the failing messages
  // rather than the whole batch. Requires ReportBatchItemFailures on the event
  // source mapping (CDK change tracked separately — see the CDK event source mapping).
  const batchItemFailures: SQSBatchItemFailure[] = [];

  try {
    if (!initialized) {
      await loadAllParams(HANDLER_PARAMS.parentSummariser);
      const tableName = await getParam(SSM_PATHS.CONTEXT_TABLE_NAME);
      const vectorBucket = await getParam(SSM_PATHS.VECTOR_BUCKET_NAME);
      const vectorIndex = await getParam(SSM_PATHS.VECTOR_INDEX_NAME);
      const queueUrl = await getParam(SSM_PATHS.ROLLUP_QUEUE_URL);
      initDynamoDB(tableName);
      initS3Vectors(vectorBucket, vectorIndex);
      initSqs(queueUrl);
      initialized = true;
    }

    for (const record of event.Records) {
      // each record has its own try/catch/finally so a failing
      // record only reports itself via batchItemFailures and publishStoredMetrics
      // always runs, even on the error path.
      try {
    const { parentUri } = JSON.parse(record.body) as { parentUri: string; triggeredAt: string };
    const rollupStart = Date.now();

    logger.info('Processing parent rollup', { parentUri });

    // Read-only cooldown check. SQS FIFO MessageGroupId serialises
    // per-parent delivery so no concurrent handler races this read.
    // The actual last_rolled_up_at marker is written in the L0 putItem
    // AFTER all side effects succeed (Bedrock, DDB, vector).
    const cooldownOk = await checkCooldown(parentUri, ROLLUP_COOLDOWN_SEC);
    if (!cooldownOk) {
      logger.info('skipped: cooldown active', { parentUri });
      metrics.addMetric('RollupCooldownDropped', MetricUnit.Count, 1);
      continue;
    }

    // 1. Query children with processing_status=ready
    const children = await queryReadyChildren(parentUri);

    if (children.length === 0) {
      logger.info('No ready children, skipping rollup', { parentUri });
      continue;
    }

    // single-segment scopes (e.g. viking://wiki/) synthesise a top-level
    // rollup. Their grandparent is the viking:// root, which is correctly excluded
    // from cascade below. This log makes the behaviour observable.
    const isTopLevelScope =
      parentUri.replace('viking://', '').replace(/\/$/, '').split('/').filter(Boolean).length === 1;
    if (isTopLevelScope) {
      logger.info('Top-level scope rollup', { parentUri });
      metrics.addMetric('RollupTopLevelScope', MetricUnit.Count, 1);
    }

    metrics.addMetric('ChildAbstractCount', MetricUnit.Count, children.length);

    // Determine rollup chain depth from URI segments
    const depth = parentUri.replace('viking://', '').split('/').filter(Boolean).length;
    metrics.addMetric('RollupChainDepth', MetricUnit.Count, depth);

    // 2. Map-reduce: chunk children into batches of ROLLUP_FANOUT_BATCH when
    //    the fanout exceeds the threshold, summarise each chunk, then synthesise
    //    a single L0 from the chunk summaries. Bounds prompt size regardless of
    //    child count.
    let summary: SummarisationResult;

    if (children.length <= ROLLUP_FANOUT_BATCH) {
      // Single-shot path: small enough to summarise directly.
      // delimit child content so the model treats it as untrusted data
      // and strip newlines from URIs to prevent prompt-injection via crafted keys.
      const childAbstracts = children
        .map((c) => renderChildBlock(c))
        .join('\n');
      summary = await summariseParent(childAbstracts);
      metrics.addMetric('RollupStrategy', MetricUnit.Count, 1); // single-shot
    } else {
      // Map step: summarise each chunk of ROLLUP_FANOUT_BATCH children.
      const chunks: ContextItem[][] = [];
      for (let i = 0; i < children.length; i += ROLLUP_FANOUT_BATCH) {
        chunks.push(children.slice(i, i + ROLLUP_FANOUT_BATCH));
      }
      logger.info('Map-reduce rollup triggered', {
        parentUri,
        childCount: children.length,
        chunkCount: chunks.length,
        batchSize: ROLLUP_FANOUT_BATCH,
      });

      const chunkSummaries: string[] = [];
      for (const chunk of chunks) {
        // same delimited, sanitised rendering as the single-shot path.
        const chunkText = chunk
          .map((c) => renderChildBlock(c))
          .join('\n');
        const chunkResult = await summariseParent(chunkText);
        chunkSummaries.push(chunkResult.abstract);
      }

      // Reduce step: synthesise chunk summaries into a single L0 via converseRaw.
      // chunk summaries are already embedded in the system prompt via
      // buildRollupReducePrompt. Pass a terse user instruction to avoid sending
      // the partial summaries twice (which doubled input tokens).
      const reducePrompt = buildRollupReducePrompt(chunkSummaries, parentUri);
      const reduceInput = 'Synthesise the partial summaries above into the final directory-level JSON.';
      const reduceRaw = await converseRaw(
        getFastModelId(),
        reducePrompt,
        reduceInput,
        1024
      );
      summary = parseReduceResult(reduceRaw);

      metrics.addMetric('RollupStrategy', MetricUnit.Count, 2); // map-reduce
      metrics.addMetric('RollupChunkCount', MetricUnit.Count, chunks.length);
    }

    // Validate abstract size and truncate if the model exceeded the budget.
    const abstractTokens = estimateTokens(summary.abstract);
    if (abstractTokens > ROLLUP_MAX_ABSTRACT_TOKENS) {
      logger.warn('Parent abstract exceeded token budget — truncating', {
        parentUri,
        abstractTokens,
        maxTokens: ROLLUP_MAX_ABSTRACT_TOKENS,
      });
      // Truncate to approximately ROLLUP_MAX_ABSTRACT_TOKENS * 3.5 chars
      // (inverse of estimateTokens).
      const maxChars = Math.floor(ROLLUP_MAX_ABSTRACT_TOKENS * 3.5);
      summary = {
        ...summary,
        abstract: summary.abstract.slice(0, maxChars),
      };
      metrics.addMetric('RollupAbstractTruncated', MetricUnit.Count, 1);
    }
    metrics.addMetric('RollupAbstractTokens', MetricUnit.Count, abstractTokens);

    // 4. Determine grandparent URI
    const grandparentUri = getParentUri(parentUri);

    // 5. Infer context type from children's actual types with
    //    URL-scope tiebreaker fallback.
    const contextType = inferContextType(parentUri, children);

    const now = new Date().toISOString();

    // 6. Write L0 item (abstract) — includes last_rolled_up_at so the
    //    cooldown marker is set atomically with the content. PutCommand
    //    replaces the row, so any prior last_rolled_up_at must be re-set
    //    here to avoid losing the cooldown state.
    await putItem({
      uri: parentUri,
      level: 0,
      parent_uri: grandparentUri ?? 'viking://',
      context_type: contextType,
      content: summary.abstract,
      is_directory: true,
      processing_status: 'ready',
      last_rolled_up_at: now,
      created_at: now,
      updated_at: now,
    });

    // 7. Write L1 item (sections)
    await putItem({
      uri: parentUri,
      level: 1,
      parent_uri: grandparentUri ?? 'viking://',
      context_type: contextType,
      content: JSON.stringify(summary.sections),
      is_directory: true,
      processing_status: 'ready',
      created_at: now,
      updated_at: now,
    });

    // 8. Generate embedding from L0+L1 text
    const embeddingText = summary.abstract + '\n' +
      summary.sections.map((s) => `${s.title}: ${s.summary}`).join('\n');
    const embedding = await generateEmbedding(embeddingText);

    // 9. Idempotent vector upsert. S3 Vectors PutVectors is upsert-by-key,
    //    so no delete step is needed. A Lambda crash can no longer leave a parent
    //    without a vector between delete and put.
    await putVector(parentUri, grandparentUri ?? 'viking://', contextType, 0, summary.abstract, embedding);

    const visibility = await awaitVectorVisibility(parentUri, embedding);
    if (!visibility.visible) {
      logger.warn('Parent vector visibility not confirmed — will converge', {
        uri: parentUri, attempts: visibility.attempts,
      });
    }

    // Cascade to grandparent. SQS FIFO + conditional cooldown at the
    // grandparent handle coalescing naturally.
    if (grandparentUri && grandparentUri !== 'viking://') {
      await enqueueRollup(grandparentUri);
      logger.info('Enqueued grandparent for rollup', { grandparentUri });
    }

    metrics.addMetric('ParentRollupLatency', MetricUnit.Milliseconds, Date.now() - rollupStart);
    logger.info('Parent rollup complete', { parentUri, childCount: children.length });
      } catch (recordError) {
        // Mark only the failing record for SQS retry. last_rolled_up_at
        // was NOT written (it's in the L0 putItem which hasn't run yet),
        // so the SQS redelivery will pass the cooldown check and retry
        // the full rollup.
        tracer.addErrorAsMetadata(recordError as Error);
        logger.error('Parent rollup record failed', {
          messageId: record.messageId,
          error: (recordError as Error).message,
        });
        metrics.addMetric('RollupRecordFailure', MetricUnit.Count, 1);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      } finally {
        // always flush buffered metrics for this record, even on failure,
        // so observability signals (ChildAbstractCount, RollupStrategy, etc.)
        // are emitted in the error path.
        try {
          metrics.publishStoredMetrics();
        } catch (metricsError) {
          logger.warn('Failed to publish stored metrics', {
            error: (metricsError as Error).message,
          });
        }
      }
    }
  } finally {
    subsegment?.close();
    if (segment) tracer.setSegment(segment);
  }

  return { batchItemFailures };
};

/**
 * Renders a child context item as a delimited block for rollup prompts.
 *
 * * Prompt-injection hardening: child URI and content both originate
 * from user-owned filesystems and must be treated as untrusted data. We:
 *   1. Strip CR/LF from the URI so a crafted key cannot inject prompt lines.
 *   2. Wrap the content in <child_content>...</child_content> tags so the
 *      model is primed (via the prompt builder's instructions) to treat
 *      anything inside the tags as data, not instructions.
 *
 * Note: escaping the literal closing tag inside content is intentionally
 * left simple — we replace any inner `</child_content>` occurrences with a
 * neutral marker so a child cannot prematurely close the delimiter.
 */
function renderChildBlock(child: ContextItem): string {
  const safeUri = (child.uri ?? '').replace(/[\r\n]+/g, ' ');
  const safeContent = (child.content ?? '').replace(
    /<\/child_content>/gi,
    '&lt;/child_content&gt;'
  );
  return `<child uri="${safeUri}">\n<child_content>\n${safeContent}\n</child_content>\n</child>`;
}

/**
 * Parses the reduce-step Bedrock response (raw string) into a SummarisationResult.
 * Mirrors src/services/bedrock.ts parseAndValidate behaviour but lives here to
 * avoid exporting the parser. Throws on malformed JSON.
 */
function parseReduceResult(raw: string): SummarisationResult {
  const trimmed = raw.trim();
  let jsonText = trimmed;
  // Strip markdown code fences if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Failed to parse reduce-step Bedrock response as JSON. Raw: ${raw}`);
  }
  const result = parsed as SummarisationResult;
  if (typeof result?.abstract !== 'string' || !Array.isArray(result?.sections)) {
    throw new Error(`Reduce-step response missing abstract/sections fields. Raw: ${raw}`);
  }
  // deep validate each section. A shallow check let responses like
  // {"abstract": "...", "sections": [{"t": "x"}]} through, producing
  // "undefined: undefined" strings in the embedding text.
  const badSection = result.sections.find(
    (s) => !s || typeof (s as { title?: unknown }).title !== 'string' ||
      typeof (s as { summary?: unknown }).summary !== 'string'
  );
  if (badSection) {
    throw new Error(
      `Reduce-step response has malformed section (expected {title: string, summary: string}). Raw: ${raw}`
    );
  }
  return result;
}

/**
 * Infers parent context_type from the actual children's types with
 * URL-scope as a tiebreaker fallback. Mixed-type directories previously always
 * stamped `memory` regardless of content.
 *
 * Rules:
 * 1. If all children share the same context_type, use it.
 * 2. If there is a unique most-frequent type, use it.
 * 3. If two or more types tie for most-frequent, fall back to URL scope.
 * 4. If children have no context_type (defensive), fall back to URL scope.
 */
function inferContextType(
  uri: string,
  children: ContextItem[]
): ContextItem['context_type'] {
  // Count occurrences of each child context_type.
  const counts = new Map<ContextItem['context_type'], number>();
  for (const child of children) {
    if (!child.context_type) continue;
    counts.set(child.context_type, (counts.get(child.context_type) ?? 0) + 1);
  }

  if (counts.size > 0) {
    // Find the max frequency.
    let maxFreq = 0;
    for (const freq of counts.values()) {
      if (freq > maxFreq) maxFreq = freq;
    }
    // Collect all types at maxFreq.
    const topTypes: ContextItem['context_type'][] = [];
    for (const [type, freq] of counts.entries()) {
      if (freq === maxFreq) topTypes.push(type);
    }
    // Unique winner — use it.
    if (topTypes.length === 1) {
      return topTypes[0];
    }
    // Tie — fall through to URL scope below.
  }

  // URL-scope fallback (previous behaviour).
  if (uri === 'viking://' || uri === 'viking:///') {
    return 'resource';
  }

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
