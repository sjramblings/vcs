/** Result type for all executor returns -- plain JSON */
export type ToolResult = Record<string, unknown>;

/** Standard error response */
export function toolError(toolName: string, message: string): ToolResult {
  return { error: true, message: `Tool ${toolName} failed: ${message}` };
}
