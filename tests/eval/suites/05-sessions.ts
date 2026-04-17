import http from 'k6/http';
import { check } from 'k6';
import { API_URL, authHeaders } from '../lib/config.ts';
import { junitSummary } from '../lib/junit.ts';

export const options = {
  thresholds: {
    'http_req_duration{endpoint:session_create}': ['p(95)<1000'],
    'http_req_duration{endpoint:session_message}': ['p(95)<1000'],
    'http_req_duration{endpoint:session_used}': ['p(95)<1000'],
    'http_req_duration{endpoint:session_commit}': ['p(95)<30000'],
    'http_req_duration{endpoint:session_delete}': ['p(95)<1000'],
    'http_req_failed{endpoint:session_create}': ['rate<0.05'],
    'http_req_failed{endpoint:session_message}': ['rate<0.05'],
    'http_req_failed{endpoint:session_used}': ['rate<0.05'],
    'http_req_failed{endpoint:session_commit}': ['rate<0.05'],
    'http_req_failed{endpoint:session_delete}': ['rate<0.05'],
    'checks{endpoint:session_create}': ['rate>0.95'],
    'checks{endpoint:session_message}': ['rate>0.95'],
    'checks{endpoint:session_used}': ['rate>0.95'],
    'checks{endpoint:session_commit}': ['rate>0.95'],
    'checks{endpoint:session_delete}': ['rate>0.95'],
  },
};

export default function () {
  const headers = authHeaders();

  // 1. Create session
  const createRes = http.post(
    `${API_URL}/sessions`,
    JSON.stringify({ agent_id: 'eval-session-agent', user_id: 'eval-user' }),
    { headers, tags: { endpoint: 'session_create' } },
  );
  check(
    createRes,
    {
      'create returns 201': (r) => r.status === 201,
      'create returns session_id': (r) => {
        try {
          const body = JSON.parse(r.body as string);
          return typeof body.session_id === 'string' && body.session_id.length > 0;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'session_create' },
  );

  let sessionId = '';
  try {
    const createBody = JSON.parse(createRes.body as string);
    sessionId = createBody.session_id || '';
  } catch {
    return; // cannot continue without a session
  }

  if (!sessionId) return;

  // 2. Add message 1 (user)
  const msg1Res = http.post(
    `${API_URL}/sessions/${sessionId}/messages`,
    JSON.stringify({ role: 'user', parts: [{ type: 'text', content: 'What is the capital of Australia?' }] }),
    { headers, tags: { endpoint: 'session_message' } },
  );
  check(msg1Res, { 'message 1 returns 200': (r) => r.status === 200 }, { endpoint: 'session_message' });

  // 3. Add message 2 (assistant)
  const msg2Res = http.post(
    `${API_URL}/sessions/${sessionId}/messages`,
    JSON.stringify({ role: 'assistant', parts: [{ type: 'text', content: 'The capital of Australia is Canberra.' }] }),
    { headers, tags: { endpoint: 'session_message' } },
  );
  check(msg2Res, { 'message 2 returns 200': (r) => r.status === 200 }, { endpoint: 'session_message' });

  // 4. Post used URIs
  const usedRes = http.post(
    `${API_URL}/sessions/${sessionId}/used`,
    JSON.stringify({ uris: ['viking://resources/eval/docs/short-test.md'] }),
    { headers, tags: { endpoint: 'session_used' } },
  );
  check(usedRes, { 'used returns 200': (r) => r.status === 200 }, { endpoint: 'session_used' });

  // 5. Commit session
  const commitRes = http.post(
    `${API_URL}/sessions/${sessionId}/commit`,
    JSON.stringify({}),
    { headers, tags: { endpoint: 'session_commit' } },
  );
  check(
    commitRes,
    {
      'commit returns 200': (r) => r.status === 200,
      'commit contains session_uri': (r) => {
        try {
          const body = JSON.parse(r.body as string);
          return typeof body.session_uri === 'string' && body.session_uri.length > 0;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'session_commit' },
  );

  // 6. Delete session
  const deleteRes = http.del(
    `${API_URL}/sessions/${sessionId}`,
    null,
    { headers, tags: { endpoint: 'session_delete' } },
  );
  check(deleteRes, { 'delete returns 200': (r) => r.status === 200 }, { endpoint: 'session_delete' });
}

export function handleSummary(data: any) {
  return junitSummary(data, '05-sessions', 'functional');
}
