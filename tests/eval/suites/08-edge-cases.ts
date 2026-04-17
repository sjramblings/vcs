import http from 'k6/http';
import { check } from 'k6';
import encoding from 'k6/encoding';
import { API_URL, authHeaders } from '../lib/config.ts';
import { junitSummary } from '../lib/junit.ts';

export const options = {
  thresholds: {
    'http_req_failed{endpoint:edge_cases}': ['rate<0.05'],
    'http_req_failed{endpoint:invalid_input}': ['rate>0.95'],
    'checks{endpoint:invalid_empty_body}': ['rate>0.95'],
    'checks{endpoint:invalid_missing_fields}': ['rate>0.95'],
    'checks{endpoint:invalid_uri}': ['rate>0.95'],
    'checks{endpoint:large_document}': ['rate>0.95'],
    'checks{endpoint:concurrent_writes}': ['rate>0.95'],
  },
};

export default function () {
  const headers = authHeaders();
  const cleanupUris: string[] = [];

  // 1. Empty body POST — expect 400
  const emptyRes = http.post(`${API_URL}/resources`, '', {
    headers,
    tags: { endpoint: 'invalid_input' },
  });
  check(
    emptyRes,
    {
      'empty body returns 400': (r) => r.status === 400,
    },
    { endpoint: 'invalid_empty_body' },
  );

  // 2. Missing required fields — expect 400
  const missingFieldsBody = JSON.stringify({
    uri_prefix: 'viking://resources/eval/',
  });
  const missingRes = http.post(`${API_URL}/resources`, missingFieldsBody, {
    headers,
    tags: { endpoint: 'invalid_input' },
  });
  check(
    missingRes,
    {
      'missing fields returns 400': (r) => r.status === 400,
    },
    { endpoint: 'invalid_missing_fields' },
  );

  // 3. Invalid URI format — expect 400
  const invalidUriRes = http.get(
    `${API_URL}/fs/read?uri=${encodeURIComponent('not-a-valid-uri')}`,
    { headers, tags: { endpoint: 'invalid_input' } },
  );
  check(
    invalidUriRes,
    {
      'invalid uri returns 400': (r) => r.status === 400,
    },
    { endpoint: 'invalid_uri' },
  );

  // 4. Large document — 10KB+ content, expect 200
  const largeContent = 'L'.repeat(10000);
  const largeBody = JSON.stringify({
    content_base64: encoding.b64encode(largeContent),
    uri_prefix: 'viking://resources/eval/',
    filename: 'large-eval-test.md',
  });
  const largeRes = http.post(`${API_URL}/resources`, largeBody, {
    headers,
    tags: { endpoint: 'edge_cases' },
  });
  check(
    largeRes,
    {
      'large document returns 200': (r) => r.status === 200,
      'large document has uri': (r) => {
        try {
          const body = JSON.parse(r.body as string);
          if (body.uri) cleanupUris.push(body.uri);
          return !!body.uri;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'large_document' },
  );

  // 5. Concurrent writes — 3 sequential POSTs to same prefix
  for (let i = 1; i <= 3; i++) {
    const concurrentBody = JSON.stringify({
      content_base64: encoding.b64encode(`concurrent test content ${i}`),
      uri_prefix: 'viking://resources/eval/concurrent/',
      filename: `concurrent-${i}.md`,
    });
    const concurrentRes = http.post(`${API_URL}/resources`, concurrentBody, {
      headers,
      tags: { endpoint: 'edge_cases' },
    });
    check(
      concurrentRes,
      {
        [`concurrent write ${i} returns 200`]: (r) => r.status === 200,
        [`concurrent write ${i} has uri`]: (r) => {
          try {
            const body = JSON.parse(r.body as string);
            if (body.uri) cleanupUris.push(body.uri);
            return !!body.uri;
          } catch {
            return false;
          }
        },
      },
      { endpoint: 'concurrent_writes' },
    );
  }

  // 6. Cleanup — delete large document and concurrent documents
  for (const uri of cleanupUris) {
    http.del(
      `${API_URL}/fs/rm?uri=${encodeURIComponent(uri)}`,
      null,
      { headers },
    );
  }
}

export function handleSummary(data: any) {
  return junitSummary(data, '08-edge-cases', 'functional');
}
