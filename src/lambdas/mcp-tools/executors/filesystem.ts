import { callApi } from '../lib/api-client';
import type { ToolResult } from '../lib/types';

/**
 * Executor for filesystem tools: read, ls, tree.
 * Maps to GET /fs/read, GET /fs/ls, GET /fs/tree on the REST API.
 */
export async function executeFilesystem(
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'read':
        return (await callApi('GET', '/fs/read', undefined, {
          uri: input.uri as string,
          level: String(input.level ?? 0),
        })) as ToolResult;

      case 'ls':
        return (await callApi('GET', '/fs/ls', undefined, {
          uri: input.uri as string,
        })) as ToolResult;

      case 'tree': {
        const params: Record<string, string> = {};
        if (input.uri) params.uri = input.uri as string;
        if (input.depth !== undefined) params.depth = String(input.depth);
        return (await callApi('GET', '/fs/tree', undefined, params)) as ToolResult;
      }

      default:
        throw new Error(`Unknown filesystem tool: ${toolName}`);
    }
  } catch (err) {
    throw new Error(
      `${toolName}(${JSON.stringify(input)}): ${(err as Error).message}`,
    );
  }
}
