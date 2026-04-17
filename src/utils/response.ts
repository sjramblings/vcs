import type { APIGatewayProxyResult } from 'aws-lambda';
import { AppError } from './errors';

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Api-Key,X-Amz-Date,Authorization,X-Amz-Security-Token,X-Amz-User-Agent',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
};

/**
 * Creates a JSON response with the given status code and body.
 */
function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * 200 OK response.
 */
export function ok(body: unknown): APIGatewayProxyResult {
  return jsonResponse(200, body);
}

/**
 * 201 Created response.
 */
export function created(body: unknown): APIGatewayProxyResult {
  return jsonResponse(201, body);
}

/**
 * 400 Bad Request response.
 */
export function badRequest(message: string, details?: unknown): APIGatewayProxyResult {
  return jsonResponse(400, { error: 'validation_error', message, details });
}

/**
 * 404 Not Found response.
 */
export function notFound(message: string): APIGatewayProxyResult {
  return jsonResponse(404, { error: 'not_found', message });
}

/**
 * 409 Conflict response.
 */
export function conflict(message: string): APIGatewayProxyResult {
  return jsonResponse(409, { error: 'conflict', message });
}

/**
 * 413 Payload Too Large response.
 */
export function payloadTooLarge(message: string): APIGatewayProxyResult {
  return jsonResponse(413, { error: 'payload_too_large', message });
}

/**
 * 500 Internal Server Error response.
 */
export function internalError(message?: string): APIGatewayProxyResult {
  return jsonResponse(500, {
    error: 'internal_error',
    message: message ?? 'An unexpected error occurred',
  });
}

/**
 * Converts an error to an appropriate API Gateway response.
 * Uses AppError status/code if available, otherwise returns 500.
 */
export function fromError(error: unknown): APIGatewayProxyResult {
  if (error instanceof AppError) {
    return jsonResponse(error.statusCode, {
      error: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  }

  return internalError();
}
