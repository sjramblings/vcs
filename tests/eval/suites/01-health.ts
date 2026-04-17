import http from 'k6/http';
import { check } from 'k6';
import { API_URL, authHeaders } from '../lib/config.ts';
import { junitSummary } from '../lib/junit.ts';

export const options = {
  thresholds: {
    'http_req_duration{endpoint:health}': ['p(95)<2000'],
    'http_req_duration{endpoint:status}': ['p(95)<5000'],
    'http_req_failed{endpoint:health}': ['rate<0.05'],
    'http_req_failed{endpoint:status}': ['rate<0.05'],
    'checks{endpoint:health}': ['rate>0.95'],
    'checks{endpoint:status}': ['rate>0.95'],
  },
};

export default function () {
  // Health probe — uses /fs/ls as the CLI does (no dedicated /health endpoint)
  const healthRes = http.get(`${API_URL}/fs/ls?uri=${encodeURIComponent('viking://resources/')}`, {
    headers: authHeaders(),
    tags: { endpoint: 'health' },
  });
  check(healthRes, { 'health returns 200': (r) => r.status === 200 }, { endpoint: 'health' });

  // Status probe — uses /search/find as a lightweight query endpoint
  const statusRes = http.post(
    `${API_URL}/search/find`,
    JSON.stringify({ query: 'ping', max_results: 1 }),
    {
      headers: authHeaders(),
      tags: { endpoint: 'status' },
    },
  );
  check(
    statusRes,
    {
      'status returns 200': (r) => r.status === 200,
      'status returns JSON': (r) => {
        try {
          JSON.parse(r.body as string);
          return true;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'status' },
  );
}

export function handleSummary(data: any) {
  return junitSummary(data, '01-health', 'functional');
}
