import { Context } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type { ToolResult } from './lib/types';
import { executeFilesystem } from './executors/filesystem';
import { executeSearch } from './executors/search';
import { executeIngestion } from './executors/ingestion';
import { executeSession } from './executors/session';

const logger = new Logger({ serviceName: 'vcs-mcp-tools' });
const tracer = new Tracer({ serviceName: 'vcs-mcp-tools' });

/**
 * AgentCore Gateway tool executor Lambda handler.
 *
 * Receives flat tool input as event, extracts tool name from
 * context.clientContext.custom.bedrockAgentCoreToolName, strips
 * the vcs___ target prefix, and dispatches to executor modules.
 *
 * Returns plain JSON objects (not MCP content arrays) -- the
 * Gateway handles MCP protocol wrapping.
 */
export const handler = async (
  event: Record<string, unknown>,
  context: Context,
): Promise<ToolResult> => {
  const subsegment = tracer.getSegment()?.addNewSubsegment('## tool-executor');
  if (subsegment) tracer.setSegment(subsegment);

  let toolName = 'unknown';
  try {
    tracer.annotateColdStart();

    // TE-01: Extract tool name from context (not event)
    const custom = (context.clientContext?.custom ?? {}) as Record<string, string>;
    const fullToolName = custom.bedrockAgentCoreToolName ?? '';

    // TE-02: Strip vcs___ target prefix before dispatching
    toolName = fullToolName.includes('___')
      ? fullToolName.substring(fullToolName.indexOf('___') + 3)
      : fullToolName;

    logger.info('Tool invocation', { toolName, fullToolName });
    tracer.putAnnotation('toolName', toolName);

    // Dispatch to executor modules
    switch (toolName) {
      case 'read':
      case 'ls':
      case 'tree':
        return await executeFilesystem(toolName, event);

      case 'find':
      case 'search':
        return await executeSearch(toolName, event);

      case 'ingest':
        return await executeIngestion(event);

      case 'create_session':
      case 'add_message':
      case 'used':
      case 'commit_session':
        return await executeSession(toolName, event);

      default:
        return { error: true, message: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    const error = err as Error;
    logger.error('Tool execution failed', { error, toolName });
    tracer.addErrorAsMetadata(error);
    return { error: true, message: `Tool ${toolName} failed: ${error.message}` };
  } finally {
    subsegment?.close();
    const segment = tracer.getSegment();
    if (subsegment && segment) tracer.setSegment(segment);
  }
};
