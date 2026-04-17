const https = require('https');
const http = require('http');
const { resolveConfig } = require('./resolve-config');

/**
 * CloudWatch Synthetics ISR (Ingest-Search-Read) canary.
 * Runs every 15 minutes -- validates the core VCS data path:
 * 1. Ingest a small document
 * 2. Search for it
 * 3. Read it back
 * 4. Clean up (delete)
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

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

exports.handler = async function () {
  const log = console.log;
  const { apiUrl, apiKey } = await resolveConfig();
  const timestamp = Date.now();
  const testContent = `Canary ISR test document created at ${timestamp}`;
  const contentBase64 = Buffer.from(testContent).toString('base64');
  let createdUri = null;

  try {
    // 1. Ingest a small document
    log('Step 1: Ingesting test document...');
    const ingestRes = await makeRequest(`${apiUrl}/resources`, apiKey, {
      method: 'POST',
      body: JSON.stringify({
        content_base64: contentBase64,
        uri_prefix: 'viking://resources/canary/',
        filename: `isr-test-${timestamp}.md`,
      }),
    });

    if (ingestRes.statusCode !== 200) {
      throw new Error(`Ingest failed: expected 200, got ${ingestRes.statusCode} -- ${ingestRes.body.substring(0, 200)}`);
    }

    const ingestBody = parseJson(ingestRes.body);
    if (!ingestBody || !ingestBody.uri) {
      throw new Error(`Ingest returned no URI: ${ingestRes.body.substring(0, 200)}`);
    }
    createdUri = ingestBody.uri;
    log(`Ingest passed: created ${createdUri}`);

    // 2. Search for the document (stateless find)
    log('Step 2: Searching for ingested document...');
    const searchRes = await makeRequest(`${apiUrl}/search/find`, apiKey, {
      method: 'POST',
      body: JSON.stringify({
        query: `canary ISR test ${timestamp}`,
        max_results: 5,
      }),
    });

    if (searchRes.statusCode !== 200) {
      throw new Error(`Search failed: expected 200, got ${searchRes.statusCode}`);
    }

    const searchBody = parseJson(searchRes.body);
    if (!searchBody) {
      throw new Error(`Search returned invalid JSON: ${searchRes.body.substring(0, 200)}`);
    }
    const results = searchBody.results || [];
    if (!results.length) {
      throw new Error(`Search returned no results for ingested document`);
    }
    const found = results.some((r) => r.uri && r.uri.includes('canary/isr-test'));
    if (!found) {
      log(`Search results: ${JSON.stringify(results.map((r) => r.uri).slice(0, 5))}`);
      throw new Error(`Search did not find the ingested canary document in ${results.length} results`);
    }
    log(`Search passed: found canary document in ${results.length} results`);

    // 3. Read the document back at L0
    log('Step 3: Reading document at L0...');
    const readUrl = `${apiUrl}/fs/read?uri=${encodeURIComponent(createdUri)}&level=0`;
    const readRes = await makeRequest(readUrl, apiKey);

    if (readRes.statusCode !== 200) {
      throw new Error(`Read failed: expected 200, got ${readRes.statusCode}`);
    }

    const readBody = parseJson(readRes.body);
    if (!readBody) {
      throw new Error(`Read returned invalid JSON: ${readRes.body.substring(0, 200)}`);
    }
    log(`Read passed: ${readRes.statusCode}`);

  } finally {
    // 4. Clean up -- delete the test document
    if (createdUri) {
      log('Step 4: Cleaning up test document...');
      try {
        const deleteRes = await makeRequest(`${apiUrl}/fs/rm?uri=${encodeURIComponent(createdUri)}`, apiKey, {
          method: 'DELETE',
        });
        log(`Cleanup: ${deleteRes.statusCode}`);
      } catch (cleanupErr) {
        log(`Cleanup warning (non-fatal): ${cleanupErr.message}`);
      }
    }
  }

  log('ISR canary completed successfully');
};
