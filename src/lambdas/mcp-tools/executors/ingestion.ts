import { callApi } from '../lib/api-client';
import type { ToolResult } from '../lib/types';

/**
 * Executor for ingestion tool: ingest.
 * Maps to POST /resources on the REST API.
 * Base64-encodes content before sending.
 */
export async function executeIngestion(
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const content = input.content as string;
    const content_base64 = Buffer.from(content).toString('base64');
    return (await callApi('POST', '/resources', {
      content_base64,
      uri_prefix: input.uri_prefix as string,
      filename: input.filename as string,
      ...(input.instruction ? { instruction: input.instruction } : {}),
    })) as ToolResult;
  } catch (err) {
    throw new Error(
      `ingest(${JSON.stringify({ uri_prefix: input.uri_prefix, filename: input.filename })}): ${(err as Error).message}`,
    );
  }
}
