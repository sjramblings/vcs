import http from 'k6/http';
import { check } from 'k6';
import encoding from 'k6/encoding';
import { API_URL, authHeaders } from '../lib/config.ts';
import { junitSummary } from '../lib/junit.ts';

export const options = {
  thresholds: {
    'http_req_duration{endpoint:ingest_short}': ['p(95)<5000'],
    'http_req_duration{endpoint:ingest_long}': ['p(95)<15000'],
    'http_req_failed{endpoint:ingest_short}': ['rate<0.05'],
    'http_req_failed{endpoint:ingest_long}': ['rate<0.05'],
    'checks{endpoint:ingest_short}': ['rate>0.95'],
    'checks{endpoint:ingest_long}': ['rate>0.95'],
  },
};

export default function () {
  // Short content ingest
  const shortBody = JSON.stringify({
    content_base64: encoding.b64encode('I prefer TypeScript for all backend services'),
    uri_prefix: 'viking://resources/eval/',
    filename: 'short-test.md',
  });

  const shortRes = http.post(`${API_URL}/resources`, shortBody, {
    headers: authHeaders(),
    tags: { endpoint: 'ingest_short' },
  });
  check(
    shortRes,
    {
      'short ingest returns 200': (r) => r.status === 200,
      'short ingest has uri': (r) => {
        try {
          const body = JSON.parse(r.body as string);
          return !!body.uri;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'ingest_short' },
  );

  // Long content ingest
  const longContent = 'A'.repeat(1000);
  const longBody = JSON.stringify({
    content_base64: encoding.b64encode(longContent),
    uri_prefix: 'viking://resources/eval/',
    filename: 'long-test.md',
  });

  const longRes = http.post(`${API_URL}/resources`, longBody, {
    headers: authHeaders(),
    tags: { endpoint: 'ingest_long' },
  });
  check(
    longRes,
    {
      'long ingest returns 200': (r) => r.status === 200,
      'long ingest has uri': (r) => {
        try {
          const body = JSON.parse(r.body as string);
          return !!body.uri;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'ingest_long' },
  );
}

export function handleSummary(data: any) {
  return junitSummary(data, '02-ingestion', 'functional');
}
