import http from 'k6/http';
import { check } from 'k6';
import { API_URL, authHeaders } from '../lib/config.ts';
import { junitSummary } from '../lib/junit.ts';

export const options = {
  thresholds: {
    'http_req_duration{endpoint:ls}': ['p(95)<2000'],
    'http_req_duration{endpoint:tree}': ['p(95)<3000'],
    'http_req_duration{endpoint:read_l0}': ['p(95)<2000'],
    'http_req_duration{endpoint:read_l1}': ['p(95)<2000'],
    'http_req_duration{endpoint:read_l2}': ['p(95)<2000'],
    'http_req_duration{endpoint:mkdir}': ['p(95)<2000'],
    'http_req_duration{endpoint:rm}': ['p(95)<3000'],
    'http_req_duration{endpoint:mv}': ['p(95)<5000'],
    'http_req_failed{endpoint:ls}': ['rate<0.05'],
    'http_req_failed{endpoint:tree}': ['rate<0.05'],
    'http_req_failed{endpoint:read_l0}': ['rate<0.05'],
    'http_req_failed{endpoint:read_l1}': ['rate<0.05'],
    'http_req_failed{endpoint:read_l2}': ['rate<0.05'],
    'http_req_failed{endpoint:mkdir}': ['rate<0.05'],
    'http_req_failed{endpoint:rm}': ['rate<0.05'],
    'http_req_failed{endpoint:mv}': ['rate<0.05'],
    'checks{endpoint:ls}': ['rate>0.95'],
    'checks{endpoint:tree}': ['rate>0.95'],
    'checks{endpoint:read_l0}': ['rate>0.95'],
    'checks{endpoint:read_l1}': ['rate>0.95'],
    'checks{endpoint:read_l2}': ['rate>0.95'],
    'checks{endpoint:mkdir}': ['rate>0.95'],
    'checks{endpoint:rm}': ['rate>0.95'],
    'checks{endpoint:mv}': ['rate>0.95'],
  },
};

export default function () {
  const headers = authHeaders();
  const evalUri = 'viking://resources/eval/';
  const docUri = 'viking://resources/eval/docs/short-test.md';
  const nestedUri = 'viking://resources/eval/nested/nested-doc.md';

  // 1. ls — list eval directory
  const lsRes = http.get(
    `${API_URL}/fs/ls?uri=${encodeURIComponent(evalUri)}`,
    { headers, tags: { endpoint: 'ls' } },
  );
  check(
    lsRes,
    {
      'ls returns 200': (r) => r.status === 200,
      'ls returns JSON': (r) => {
        try {
          JSON.parse(r.body as string);
          return true;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'ls' },
  );

  // 2. tree — tree view of eval directory
  const treeRes = http.get(
    `${API_URL}/fs/tree?uri=${encodeURIComponent(evalUri)}&depth=5`,
    { headers, tags: { endpoint: 'tree' } },
  );
  check(
    treeRes,
    {
      'tree returns 200': (r) => r.status === 200,
      'tree returns JSON': (r) => {
        try {
          JSON.parse(r.body as string);
          return true;
        } catch {
          return false;
        }
      },
    },
    { endpoint: 'tree' },
  );

  // 3. read_l0 — read metadata only
  const readL0Res = http.get(
    `${API_URL}/fs/read?uri=${encodeURIComponent(docUri)}&level=0`,
    { headers, tags: { endpoint: 'read_l0' } },
  );
  check(readL0Res, { 'read_l0 returns 200': (r) => r.status === 200 }, { endpoint: 'read_l0' });

  // 4. read_l1 — read summary
  const readL1Res = http.get(
    `${API_URL}/fs/read?uri=${encodeURIComponent(docUri)}&level=1`,
    { headers, tags: { endpoint: 'read_l1' } },
  );
  check(readL1Res, { 'read_l1 returns 200': (r) => r.status === 200 }, { endpoint: 'read_l1' });

  // 5. read_l2 — read full content
  const readL2Res = http.get(
    `${API_URL}/fs/read?uri=${encodeURIComponent(docUri)}&level=2`,
    { headers, tags: { endpoint: 'read_l2' } },
  );
  check(readL2Res, { 'read_l2 returns 200': (r) => r.status === 200 }, { endpoint: 'read_l2' });

  // 6. mkdir — create test directory (clean up first if it exists from a prior run)
  const mkdirCleanupUri = 'viking://resources/eval/fs-test-dir/';
  http.del(
    `${API_URL}/fs/rm?uri=${encodeURIComponent(mkdirCleanupUri)}`,
    null,
    { headers },
  );
  const mkdirRes = http.post(
    `${API_URL}/fs/mkdir`,
    JSON.stringify({ uri: mkdirCleanupUri }),
    { headers, tags: { endpoint: 'mkdir' } },
  );
  check(mkdirRes, { 'mkdir returns 201': (r) => r.status === 201 }, { endpoint: 'mkdir' });

  // 7. mv — move the test directory we just created (self-contained, no dependency on seed data)
  const mvRes = http.post(
    `${API_URL}/fs/mv`,
    JSON.stringify({
      from_uri: mkdirCleanupUri,
      to_uri: 'viking://resources/eval/fs-test-moved/',
    }),
    { headers, tags: { endpoint: 'mv' } },
  );
  check(mvRes, { 'mv returns 200': (r) => r.status === 200 }, { endpoint: 'mv' });

  // 8. rm — remove the moved directory (query params, not JSON body)
  const rmRes = http.del(
    `${API_URL}/fs/rm?uri=${encodeURIComponent('viking://resources/eval/fs-test-moved/')}`,
    null,
    { headers, tags: { endpoint: 'rm' } },
  );
  check(rmRes, { 'rm returns 200': (r) => r.status === 200 }, { endpoint: 'rm' });
}

export function handleSummary(data: any) {
  return junitSummary(data, '03-filesystem', 'functional');
}
