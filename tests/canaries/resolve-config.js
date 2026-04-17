/**
 * Shared config resolver for VCS canaries.
 * Resolves API URL from SSM and API key value from SSM + API Gateway at runtime.
 * Caches resolved values for the Lambda container lifetime.
 */

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { APIGatewayClient, GetApiKeyCommand } = require('@aws-sdk/client-api-gateway');

let cachedConfig = null;

async function resolveConfig() {
  if (cachedConfig) return cachedConfig;

  const ssmClient = new SSMClient({});
  const apiGwClient = new APIGatewayClient({});

  // Resolve API URL from SSM
  const urlParam = await ssmClient.send(new GetParameterCommand({
    Name: process.env.VCS_API_URL_PARAM || '/vcs/api/rest-api-url',
  }));
  const apiUrl = urlParam.Parameter.Value;

  // Resolve API key ID from SSM, then get actual key value from API Gateway
  const keyIdParam = await ssmClient.send(new GetParameterCommand({
    Name: process.env.VCS_API_KEY_PARAM || '/vcs/api/api-key-id',
  }));
  const apiKeyId = keyIdParam.Parameter.Value;

  const keyResult = await apiGwClient.send(new GetApiKeyCommand({
    apiKey: apiKeyId,
    includeValue: true,
  }));
  const apiKey = keyResult.value;

  cachedConfig = { apiUrl, apiKey };
  return cachedConfig;
}

module.exports = { resolveConfig };
