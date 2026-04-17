const https = require('https');
const http = require('http');
const { resolveConfig } = require('./resolve-config');

/**
 * CloudWatch Synthetics health canary.
 * Runs every 5 minutes -- validates VCS API is responsive.
 * Hits /fs/ls (same as CLI health check) and /search/find.
 */

function makeRequest(requestUrl, apiKey, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(requestUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        ...options.headers,
      },
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

exports.handler = async function () {
  const log = console.log;
  const { apiUrl, apiKey } = await resolveConfig();

  // 1. Health check -- /fs/ls on root namespace
  log('Checking /fs/ls health endpoint...');
  const healthUrl = `${apiUrl}/fs/ls?uri=${encodeURIComponent('viking://resources/')}`;
  const healthRes = await makeRequest(healthUrl, apiKey);

  if (healthRes.statusCode !== 200) {
    throw new Error(`Health check failed: expected 200, got ${healthRes.statusCode}`);
  }
  log(`Health check passed: ${healthRes.statusCode}`);

  // 2. Search check -- /search/find with lightweight query
  log('Checking /search/find endpoint...');
  const searchUrl = `${apiUrl}/search/find`;
  const searchRes = await makeRequest(searchUrl, apiKey, {
    method: 'POST',
    body: JSON.stringify({ query: 'canary-health-ping', max_results: 1 }),
  });

  if (searchRes.statusCode !== 200) {
    throw new Error(`Search check failed: expected 200, got ${searchRes.statusCode}`);
  }

  // Validate JSON response
  try {
    JSON.parse(searchRes.body);
  } catch (e) {
    throw new Error(`Search check returned invalid JSON: ${searchRes.body.substring(0, 200)}`);
  }
  log(`Search check passed: ${searchRes.statusCode}`);

  log('Health canary completed successfully');
};
