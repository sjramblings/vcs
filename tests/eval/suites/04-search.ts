import http from 'k6/http';
import { check } from 'k6';
import { API_URL, authHeaders } from '../lib/config.ts';
import { junitSummary } from '../lib/junit.ts';

export const options = {
  thresholds: {
    'http_req_duration{endpoint:find}': ['p(95)<2000'],
    'http_req_duration{endpoint:search}': ['p(95)<3000'],
    'http_req_failed{endpoint:find}': ['rate<0.05'],
    'http_req_failed{endpoint:search}': ['rate<0.05'],
    'checks{endpoint:find}': ['rate>0.95'],
    'checks{endpoint:search}': ['rate>0.95'],
  },
};

export default function () {
  const headers = authHeaders();

  // 1. Stateless find — search for known seed content
  const findRes = http.post(
    `${API_URL}/search/find`,
    JSON.stringify({ query: 'I prefer TypeScript', max_results: 5 }),
    { headers, tags: { endpoint: 'find' } },
  );
  check(
    findRes,
    {
      'find returns 200': (r) => r.status === 200,
      'find returns JSON': (r) => {
        try {
          JSON.parse(r.body as string);
          return true;
        } catch {
          return false;
        }
      },
      'find has results with score > 0.3': (r) => {
        try {
          const body = JSON.parse(r.body as string);
          const results = body.results || body;
          return Array.isArray(results) && results.some((item: any) => item.score > 0.3);
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'find' },
  );

  // 2. Session-aware search — create temporary session, search, then cleanup
  const createRes = http.post(
    `${API_URL}/sessions`,
    JSON.stringify({ agent_id: 'eval-search-agent', user_id: 'eval-user' }),
    { headers },
  );

  let sessionId = '';
  try {
    const createBody = JSON.parse(createRes.body as string);
    sessionId = createBody.session_id || '';
  } catch {
    // session creation failed, skip search test
  }

  if (sessionId) {
    const searchRes = http.post(
      `${API_URL}/search/search`,
      JSON.stringify({ query: 'TypeScript backend', session_id: sessionId, max_results: 5 }),
      { headers, tags: { endpoint: 'search' } },
    );
    check(
      searchRes,
      {
        'search returns 200': (r) => r.status === 200,
        'search returns JSON': (r) => {
          try {
            JSON.parse(r.body as string);
            return true;
          } catch {
            return false;
          }
        },
      },
      { endpoint: 'search' },
    );

    // 3. Cleanup — delete temporary session
    http.del(`${API_URL}/sessions/${sessionId}`, null, { headers });
  }
}

export function handleSummary(data: any) {
  return junitSummary(data, '04-search', 'functional');
}
