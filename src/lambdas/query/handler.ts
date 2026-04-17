import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import { SSM_PATHS } from '../../../lib/config';
import { loadAllParams, getParam } from '../../services/ssm';
import { initDynamoDB, initSessionsDB, getSessionContext } from '../../services/dynamodb';
import { initS3Vectors } from '../../services/s3-vectors';
import { initBedrock, analyseIntent } from '../../services/bedrock';
import { performFind, performSearch } from '../../services/retrieval';
import { findRequestSchema, searchRequestSchema } from '../../utils/validators';
import {
  ok,
  badRequest,
  notFound,
  internalError,
  fromError,
} from '../../utils/response';
import type { FindRequest, SearchRequest } from '../../types/search';
import { NotFoundError } from '../../utils/errors';

const logger = new Logger({ serviceName: 'vcs-query' });
const tracer = new Tracer({ serviceName: 'vcs-query' });
const metrics = new Metrics({ namespace: 'VCS', serviceName: 'vcs-query' });
let initialised = false;

/**
 * Initialise all service dependencies on first cold start.
 * Reads SSM parameters and wires up DynamoDB, S3 Vectors, and Bedrock clients.
 */
async function init(): Promise<void> {
  if (initialised) return;

  await loadAllParams([
    SSM_PATHS.CONTEXT_TABLE_NAME,
    SSM_PATHS.SESSIONS_TABLE_NAME,
    SSM_PATHS.VECTOR_BUCKET_NAME,
    SSM_PATHS.VECTOR_INDEX_NAME,
  ]);

  const contextTable = await getParam(SSM_PATHS.CONTEXT_TABLE_NAME);
  const sessionsTable = await getParam(SSM_PATHS.SESSIONS_TABLE_NAME);
  const vectorBucket = await getParam(SSM_PATHS.VECTOR_BUCKET_NAME);
  const vectorIndex = await getParam(SSM_PATHS.VECTOR_INDEX_NAME);

  initDynamoDB(contextTable);
  initSessionsDB(sessionsTable);
  initS3Vectors(vectorBucket, vectorIndex);
  initBedrock();

  initialised = true;
}

/**
 * Query Lambda handler.
 * Routes: POST /search/find, POST /search/search
 *
 * NOTE: API Gateway strips the stage prefix (/v1/) from event.resource.
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
    await init();

    const { resource } = event;

    let result: APIGatewayProxyResult;
    switch (resource) {
      case '/search/find':
        result = await handleFind(event);
        break;
      case '/search/search':
        result = await handleSearch(event);
        break;
      default:
        result = badRequest('Unknown route');
    }

    tracer.addResponseAsMetadata(result, 'handler');
    return result;
  } catch (error) {
    tracer.addErrorAsMetadata(error as Error);
    throw error;
  } finally {
    subsegment?.close();
    if (segment) tracer.setSegment(segment);
  }
};

/**
 * POST /search/find -- Stateless single-query retrieval.
 * Validates request, calls performFind, returns FindResponse.
 */
async function handleFind(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const queryStart = Date.now();
    metrics.addDimension('SearchType', 'find');

    let parsedBody: unknown;
    try {
      parsedBody = event.body ? JSON.parse(event.body) : null;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (parsedBody === null) {
      return badRequest('Request body is required');
    }

    const validated = findRequestSchema.safeParse(parsedBody);
    if (!validated.success) {
      return badRequest('Invalid request', validated.error.issues);
    }

    const searchStart = Date.now();
    const result = await performFind(validated.data as FindRequest);
    metrics.addMetric('VectorSearchLatency', MetricUnit.Milliseconds, Date.now() - searchStart);

    const resultBody = JSON.parse(JSON.stringify(result));
    metrics.addMetric('ResultCount', MetricUnit.Count, resultBody.results?.length ?? 0);
    metrics.addMetric('QueryLatency', MetricUnit.Milliseconds, Date.now() - queryStart);
    metrics.publishStoredMetrics();

    return ok(result);
  } catch (error) {
    logger.error('Find operation failed', { error: error as Error });
    if (error instanceof NotFoundError) {
      return fromError(error);
    }
    return internalError();
  }
}

/**
 * POST /search/search -- Session-aware multi-query retrieval.
 * Validates request, reads session context, runs intent analysis,
 * handles chitchat (0 sub-queries), returns SearchResponse.
 */
async function handleSearch(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const queryStart = Date.now();
    metrics.addDimension('SearchType', 'search');

    let parsedBody: unknown;
    try {
      parsedBody = event.body ? JSON.parse(event.body) : null;
    } catch {
      return badRequest('Invalid JSON body');
    }

    if (parsedBody === null) {
      return badRequest('Request body is required');
    }

    const validated = searchRequestSchema.safeParse(parsedBody);
    if (!validated.success) {
      return badRequest('Invalid request', validated.error.issues);
    }

    const request = validated.data as SearchRequest;

    // Read session context -- 404 if session not found
    let sessionContext: { summary: string; messages: Array<{ role: string; content: string }> };
    try {
      sessionContext = await getSessionContext(request.session_id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return notFound(`Session not found: ${request.session_id}`);
      }
      throw error;
    }

    // Intent analysis
    const intentStart = Date.now();
    const intentResult = await analyseIntent(
      request.query,
      sessionContext.summary,
      sessionContext.messages
    );
    metrics.addMetric('IntentAnalysisLatency', MetricUnit.Milliseconds, Date.now() - intentStart);

    // Chitchat -- no retrieval needed
    if (intentResult.queries.length === 0) {
      metrics.addMetric('ResultCount', MetricUnit.Count, 0);
      metrics.addMetric('QueryLatency', MetricUnit.Milliseconds, Date.now() - queryStart);
      metrics.publishStoredMetrics();

      return ok({
        memories: [],
        resources: [],
        skills: [],
        query_plan: [],
        trajectory: [],
        reason: 'no_retrieval_needed',
        tokens_saved_estimate: 0,
      });
    }

    // Perform multi-query search
    const searchStart = Date.now();
    const result = await performSearch(request, intentResult.queries);
    metrics.addMetric('VectorSearchLatency', MetricUnit.Milliseconds, Date.now() - searchStart);

    const totalResults = (result.resources?.length ?? 0) + (result.memories?.length ?? 0) + (result.skills?.length ?? 0);
    metrics.addMetric('ResultCount', MetricUnit.Count, totalResults);
    metrics.addMetric('QueryLatency', MetricUnit.Milliseconds, Date.now() - queryStart);
    metrics.publishStoredMetrics();

    return ok(result);
  } catch (error) {
    logger.error('Search operation failed', { error: error as Error });
    if (error instanceof NotFoundError) {
      return fromError(error);
    }
    return internalError();
  }
}
