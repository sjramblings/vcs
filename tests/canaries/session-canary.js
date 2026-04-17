const https = require('https');
const http = require('http');
const { resolveConfig } = require('./resolve-config');

/**
 * CloudWatch Synthetics session lifecycle canary.
 * Runs every 30 minutes -- validates the full session flow:
 * 1. Create session
 * 2. Add user message
 * 3. Add assistant message
 * 4. Commit session
 * 5. Delete session
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
  let sessionId = null;

  try {
    // 1. Create session
    log('Step 1: Creating session...');
    const createRes = await makeRequest(`${apiUrl}/sessions`, apiKey, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'canary-session-agent',
        user_id: 'canary-user',
      }),
    });

    if (createRes.statusCode !== 201) {
      throw new Error(`Session create failed: expected 201, got ${createRes.statusCode} -- ${createRes.body.substring(0, 200)}`);
    }

    const createBody = parseJson(createRes.body);
    if (!createBody || !createBody.session_id) {
      throw new Error(`Session create returned no session_id: ${createRes.body.substring(0, 200)}`);
    }
    sessionId = createBody.session_id;
    log(`Session created: ${sessionId}`);

    // 2. Add user message
    log('Step 2: Adding user message...');
    const msg1Res = await makeRequest(`${apiUrl}/sessions/${sessionId}/messages`, apiKey, {
      method: 'POST',
      body: JSON.stringify({
        role: 'user',
        parts: [{ type: 'text', content: 'Canary session test -- what time is it?' }],
      }),
    });

    if (msg1Res.statusCode !== 200) {
      throw new Error(`Message 1 failed: expected 200, got ${msg1Res.statusCode}`);
    }
    log('User message added');

    // 3. Add assistant message
    log('Step 3: Adding assistant message...');
    const msg2Res = await makeRequest(`${apiUrl}/sessions/${sessionId}/messages`, apiKey, {
      method: 'POST',
      body: JSON.stringify({
        role: 'assistant',
        parts: [{ type: 'text', content: 'This is a canary test response.' }],
      }),
    });

    if (msg2Res.statusCode !== 200) {
      throw new Error(`Message 2 failed: expected 200, got ${msg2Res.statusCode}`);
    }
    log('Assistant message added');

    // 4. Commit session
    log('Step 4: Committing session...');
    const commitRes = await makeRequest(`${apiUrl}/sessions/${sessionId}/commit`, apiKey, {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (commitRes.statusCode !== 200) {
      throw new Error(`Session commit failed: expected 200, got ${commitRes.statusCode}`);
    }

    const commitBody = parseJson(commitRes.body);
    if (!commitBody || !commitBody.session_uri) {
      throw new Error(`Session commit returned no session_uri: ${commitRes.body.substring(0, 200)}`);
    }
    log(`Session committed: ${commitBody.session_uri}`);

  } finally {
    // 5. Delete session (cleanup)
    if (sessionId) {
      log('Step 5: Deleting session...');
      try {
        const deleteRes = await makeRequest(`${apiUrl}/sessions/${sessionId}`, apiKey, {
          method: 'DELETE',
        });
        log(`Session deleted: ${deleteRes.statusCode}`);
      } catch (cleanupErr) {
        log(`Cleanup warning (non-fatal): ${cleanupErr.message}`);
      }
    }
  }

  log('Session canary completed successfully');
};
