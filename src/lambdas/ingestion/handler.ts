import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { SSM_PATHS, HANDLER_PARAMS, SHORT_CONTENT_TOKEN_THRESHOLD } from '../../../lib/config';
import { loadAllParams, getParam } from '../../services/ssm';
import { initDynamoDB } from '../../services/dynamodb';
import { initBedrock } from '../../services/bedrock';
import { initS3 } from '../../services/s3';
import { initS3Vectors } from '../../services/s3-vectors';
import { initSqs } from '../../services/sqs';
import { writeDocument } from '../../services/write-pipeline';
import { ingestRequestSchema } from '../../utils/validators';
import { ok, badRequest, conflict, fromError, payloadTooLarge } from '../../utils/response';
const logger = new Logger({ serviceName: 'vcs-ingestion' });
const tracer = new Tracer({ serviceName: 'vcs-ingestion' });
const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-ingestion' });
let initialized = false;

/**
 * Ingestion Lambda handler.
 * Route: POST /resources
 *
 * Accepts a base64-encoded markdown document, processes it through the
 * summarisation and embedding pipeline, and stores results across
 * DynamoDB (L0/L1/L2), S3 (L2 full content), and S3 Vectors (embedding).
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
      await loadAllParams(HANDLER_PARAMS.ingestion);
      const tableName = await getParam(SSM_PATHS.CONTEXT_TABLE_NAME);
      const contentBucket = await getParam(SSM_PATHS.CONTENT_BUCKET_NAME);
      const vectorBucket = await getParam(SSM_PATHS.VECTOR_BUCKET_NAME);
      const vectorIndex = await getParam(SSM_PATHS.VECTOR_INDEX_NAME);
      const rollupQueueUrl = await getParam(SSM_PATHS.ROLLUP_QUEUE_URL);

      initDynamoDB(tableName);
      initS3(contentBucket);
      initS3Vectors(vectorBucket, vectorIndex);
      initSqs(rollupQueueUrl);
      initBedrock();
      initialized = true;
    }

    // Parse and validate request body
    let parsedBody: unknown;
    try {
      parsedBody = event.body ? JSON.parse(event.body) : {};
    } catch {
      return badRequest('Invalid JSON body');
    }

    const parsed = ingestRequestSchema.safeParse(parsedBody);
    if (!parsed.success) {
      return badRequest('Invalid request', parsed.error.issues);
    }

    const { content_base64, uri_prefix, filename, instruction } = parsed.data;

    // Decode base64 content
    const content = Buffer.from(content_base64, 'base64').toString('utf-8');

    // Generate leaf URI (document, not directory -- no trailing slash)
    const leafUri = uri_prefix + filename;

    const pipelineStart = Date.now();

    // Add ContentType dimension
    const contentType = leafUri.endsWith('.md') ? 'markdown' : 'other';
    metrics.addDimension('ContentType', contentType);

    const estimatedTokens = Math.ceil(content.length / 4);
    metrics.addMetric('ContentTokens', MetricUnit.Count, estimatedTokens);

    const summarisationBypassed = estimatedTokens <= SHORT_CONTENT_TOKEN_THRESHOLD ? 1 : 0;
    metrics.addMetric('SummarisationBypassed', MetricUnit.Count, summarisationBypassed);

    // Delegate to unified write pipeline
    const writeResult = await writeDocument({ uri: leafUri, content, instruction, requireLock: false });

    if (!writeResult.lockAcquired) {
      metrics.publishStoredMetrics();
      return conflict('Resource is currently being processed');
    }

    metrics.addMetric('IngestionLatency', MetricUnit.Milliseconds, Date.now() - pipelineStart);
    metrics.publishStoredMetrics();

    const result = ok({ status: 'ok', uri: leafUri, processing_status: writeResult.processingStatus });
    tracer.addResponseAsMetadata(result, 'handler');
    return result;
  } catch (error) {
    if (error instanceof Error && error.message?.includes('Content too large')) {
      metrics.publishStoredMetrics();
      return payloadTooLarge(error.message);
    }
    tracer.addErrorAsMetadata(error as Error);
    logger.error('Ingestion handler failed', { error: error as Error });
    return fromError(error);
  } finally {
    subsegment?.close();
    if (segment) tracer.setSegment(segment);
  }
};
