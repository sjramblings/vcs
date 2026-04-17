import http from 'k6/http';
import { check, sleep } from 'k6';
import encoding from 'k6/encoding';
import { API_URL, authHeaders } from '../lib/config.ts';
import { junitSummary } from '../lib/junit.ts';

export const options = {
  thresholds: {
    'checks{endpoint:parent_rollup}': ['rate>0.90'],
    'checks{endpoint:memory_extraction}': ['rate>0.90'],
  },
};

export default function () {
  const headers = authHeaders();

  // ── Part A: Parent Rollup Verification ──────────────────────────────────

  // 1. Use a unique parent prefix per run to avoid SQS FIFO dedup window conflicts
  const runId = Date.now().toString();
  const asyncPrefix = `viking://resources/eval/async-${runId}/`;

  const child1Res = http.post(
    `${API_URL}/resources`,
    JSON.stringify({
      content_base64: encoding.b64encode('First async test document about distributed systems and cloud architecture patterns'),
      uri_prefix: asyncPrefix,
      filename: 'child-1.md',
    }),
    { headers },
  );
  check(child1Res, {
    'child-1 ingest returns 200': (r) => r.status === 200,
  });

  const child2Res = http.post(
    `${API_URL}/resources`,
    JSON.stringify({
      content_base64: encoding.b64encode('Second async test document about microservices event-driven design and message queues'),
      uri_prefix: asyncPrefix,
      filename: 'child-2.md',
    }),
    { headers },
  );
  check(child2Res, {
    'child-2 ingest returns 200': (r) => r.status === 200,
  });

  // 2. Poll for parent rollup — parent directory should get content after SQS triggers Parent Summariser
  let rollupFound = false;
  const parentUri = asyncPrefix;
  for (let i = 0; i < 15; i++) {
    sleep(2);
    const readRes = http.get(
      `${API_URL}/fs/read?uri=${encodeURIComponent(parentUri)}&level=1`,
      { headers },
    );
    if (readRes.status === 200) {
      try {
        const body = JSON.parse(readRes.body as string);
        if (body.content && body.content.length > 0) {
          rollupFound = true;
          break;
        }
      } catch { /* continue polling */ }
    }
  }
  check(null, {
    'parent rollup completed': () => rollupFound,
  }, { endpoint: 'parent_rollup' });

  // ── Part B: Memory Extraction Verification ──────────────────────────────

  // 3. Create a session, add messages with memory-worthy content, commit
  const sessionRes = http.post(
    `${API_URL}/sessions`,
    JSON.stringify({ agent_id: 'eval-async-agent', user_id: 'eval-user' }),
    { headers },
  );
  check(sessionRes, {
    'session create returns 201': (r) => r.status === 201,
  });

  let sessionId = '';
  try {
    const sessionBody = JSON.parse(sessionRes.body as string);
    sessionId = sessionBody.session_id;
  } catch { /* session creation failed */ }

  if (sessionId) {
    http.post(
      `${API_URL}/sessions/${sessionId}/messages`,
      JSON.stringify({ role: 'user', parts: [{ type: 'text', content: 'Remember that my favorite programming language is Rust' }] }),
      { headers },
    );

    http.post(
      `${API_URL}/sessions/${sessionId}/messages`,
      JSON.stringify({ role: 'assistant', parts: [{ type: 'text', content: "I'll remember that your favorite programming language is Rust." }] }),
      { headers },
    );

    const commitRes = http.post(
      `${API_URL}/sessions/${sessionId}/commit`,
      JSON.stringify({}),
      { headers },
    );
    check(commitRes, {
      'session commit returns 200': (r) => r.status === 200,
    });

    // 4. Poll for memory extraction — SNS triggers Memory Bridge Lambda which creates memory entries
    let memoryFound = false;
    for (let i = 0; i < 15; i++) {
      sleep(2);
      const lsRes = http.get(
        `${API_URL}/fs/ls?uri=${encodeURIComponent('viking://user/memories/')}`,
        { headers },
      );
      if (lsRes.status === 200) {
        try {
          const body = JSON.parse(lsRes.body as string);
          // Check if any memory entries exist (memory extraction creates entries)
          if (body.items && body.items.length > 0) {
            memoryFound = true;
            break;
          }
        } catch { /* continue polling */ }
      }
    }
    check(null, {
      'memory extraction completed': () => memoryFound,
    }, { endpoint: 'memory_extraction' });

    // ── Cleanup ─────────────────────────────────────────────────────────────

    // 5. Delete the session
    http.del(`${API_URL}/sessions/${sessionId}`, null, { headers });
  } else {
    // Session creation failed — mark memory extraction as failed
    check(null, {
      'memory extraction completed': () => false,
    }, { endpoint: 'memory_extraction' });
  }

  // 6. Delete the parent test directory
  http.del(
    `${API_URL}/fs/rm?uri=${encodeURIComponent(asyncPrefix)}`,
    null,
    { headers },
  );
}

export function handleSummary(data: any) {
  return junitSummary(data, '07-async-flows', 'functional');
}
