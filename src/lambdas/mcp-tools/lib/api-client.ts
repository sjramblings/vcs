import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'vcs-mcp-tools' });

const ssmClient = new SSMClient({});
const apigwClient = new APIGatewayClient({});

// Module-level cache for warm Lambda reuse
let cachedApiUrl: string | undefined;
let cachedApiKey: string | undefined;

/**
 * Load API URL from SSM and API key value via API Gateway at cold start.
 * Caches values for warm Lambda invocations.
 */
async function loadConfig(): Promise<{ apiUrl: string; apiKey: string }> {
  if (cachedApiUrl && cachedApiKey) {
    return { apiUrl: cachedApiUrl, apiKey: cachedApiKey };
  }

  // If API_URL is set as env var (from CDK), use it directly
  cachedApiUrl = process.env.API_URL;
  if (!cachedApiUrl) {
    const urlResp = await ssmClient.send(new GetParameterCommand({
      Name: '/vcs/api/rest-api-url',
    }));
    cachedApiUrl = urlResp.Parameter?.Value;
    if (!cachedApiUrl) {
      throw new Error('Failed to load API URL from SSM parameter /vcs/api/rest-api-url');
    }
  }

  // Load API key ID from SSM, then get the actual key value via API Gateway
  const keyIdResp = await ssmClient.send(new GetParameterCommand({
    Name: '/vcs/api/api-key-id',
  }));
  const apiKeyId = keyIdResp.Parameter?.Value;
  if (!apiKeyId) {
    throw new Error('Failed to load API key ID from SSM parameter /vcs/api/api-key-id');
  }

  const keyResp = await apigwClient.send(new GetApiKeyCommand({
    apiKey: apiKeyId,
    includeValue: true,
  }));
  cachedApiKey = keyResp.value;
  if (!cachedApiKey) {
    throw new Error(`Failed to retrieve API key value for key ID: ${apiKeyId}`);
  }

  logger.info('API config loaded', { apiUrl: cachedApiUrl, apiKeyId });
  return { apiUrl: cachedApiUrl, apiKey: cachedApiKey };
}

/**
 * Make an HTTP request to the VCS REST API through API Gateway.
 * Uses API key authentication (x-api-key header).
 */
export async function callApi(
  method: string,
  path: string,
  body?: unknown,
  queryParams?: Record<string, string>,
): Promise<unknown> {
  const { apiUrl, apiKey } = await loadConfig();

  // Ensure the stage prefix (e.g. /v1) is preserved when joining path
  const base = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
  const url = new URL(`${base}${path}`);

  // Append query parameters
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }

  const requestBody = body ? JSON.stringify(body) : undefined;

  logger.debug('Calling REST API', { method, path, queryParams });

  const response = await fetch(url.toString(), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: requestBody,
  });

  const responseBody = await response.text();

  logger.debug('REST API response', {
    status: response.status,
    bodyLength: responseBody.length,
  });

  if (!response.ok) {
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${responseBody}`,
    );
  }

  return JSON.parse(responseBody);
}
