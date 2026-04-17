import { Logger } from '@aws-lambda-powertools/logger';

/**
 * Creates a structured JSON logger for a Lambda function.
 */
export const createLogger = (serviceName: string): Logger =>
  new Logger({ serviceName });
