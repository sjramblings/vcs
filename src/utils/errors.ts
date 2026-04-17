/**
 * Base application error with HTTP status code and error code.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Resource not found (HTTP 404).
 */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'not_found', message);
    this.name = 'NotFoundError';
  }
}

/**
 * Resource conflict (HTTP 409).
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'conflict', message);
    this.name = 'ConflictError';
  }
}

/**
 * Validation error (HTTP 400).
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'validation_error', message, details);
    this.name = 'ValidationError';
  }
}
