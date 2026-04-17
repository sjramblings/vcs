import { callApi } from '../lib/api-client';
import type { ToolResult } from '../lib/types';

/**
 * Executor for session tools: create_session, add_message, used, commit_session.
 * Maps to POST /sessions and POST /sessions/{id}/* on the REST API.
 */
export async function executeSession(
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'create_session': {
        const result = (await callApi('POST', '/sessions')) as {
          session_id: string;
        };
        return { session_id: result.session_id };
      }

      case 'add_message':
        return (await callApi(
          'POST',
          `/sessions/${input.session_id}/messages`,
          {
            role: input.role,
            parts: [{ type: 'text', content: input.content }],
          },
        )) as ToolResult;

      case 'used':
        return (await callApi(
          'POST',
          `/sessions/${input.session_id}/used`,
          {
            uris: input.uris,
            ...(input.skill ? { skill: input.skill } : {}),
          },
        )) as ToolResult;

      case 'commit_session':
        return (await callApi(
          'POST',
          `/sessions/${input.session_id}/commit`,
        )) as ToolResult;

      default:
        throw new Error(`Unknown session tool: ${toolName}`);
    }
  } catch (err) {
    throw new Error(
      `${toolName}(${JSON.stringify(input)}): ${(err as Error).message}`,
    );
  }
}
