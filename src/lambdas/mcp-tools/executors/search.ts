import { callApi } from '../lib/api-client';
import type { ToolResult } from '../lib/types';

/**
 * Executor for search tools: find, search.
 * Maps to POST /search/find, POST /search/search on the REST API.
 */
export async function executeSearch(
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'find':
        return (await callApi('POST', '/search/find', {
          query: input.query,
          scope: input.scope,
          max_results: input.max_results ?? 5,
        })) as ToolResult;

      case 'search':
        return (await callApi('POST', '/search/search', {
          query: input.query,
          session_id: input.session_id,
          max_results: input.max_results ?? 5,
        })) as ToolResult;

      default:
        throw new Error(`Unknown search tool: ${toolName}`);
    }
  } catch (err) {
    throw new Error(
      `${toolName}(${JSON.stringify(input)}): ${(err as Error).message}`,
    );
  }
}
