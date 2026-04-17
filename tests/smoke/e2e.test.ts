import { describe, it, expect, beforeAll } from 'vitest';

/**
 * v1-stable e2e smoke test.
 *
 * Runs against a real CDK-deployed VcsStack. The test ingests a single
 * markdown document and asserts the full OpenViking pipeline works:
 *
 *   1. POST /resources       — ingestion Lambda writes L0/L1/L2 + vector
 *   2. wait for rollup       — parent-summariser fires, parent L0
 *                               gets last_rolled_up_at populated
 *   3. GET /fs/read          — filesystem Lambda returns content at
 *                               levels 0, 1, and 2
 *   4. POST /search/find     — query Lambda drill-downs and returns
 *                               the ingested URI in the results
 *
 * This is the one test the v1-stable Definition of Done requires to pass
 * before tagging v1.0.0-stable.
 *
 * Environment:
 *   VCS_API_URL  — full URL of the deployed API Gateway stage
 *                  (e.g. https://abc123.execute-api.ap-southeast-2.amazonaws.com/prod/)
 *   VCS_API_KEY  — x-api-key value for the usage plan
 *
 * Skipped automatically if either env var is missing, so local unit
 * `vitest run` doesn't try to hit AWS. CI wires these into a preview
 * deploy before running `npm run test:e2e`.
 */

const apiUrl = process.env.VCS_API_URL;
const apiKey = process.env.VCS_API_KEY;
const skip = !apiUrl || !apiKey;

const ROLLUP_WAIT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;

describe.skipIf(skip)('v1-stable e2e smoke: ingest → rollup → read → find', () => {
  const runId = `smoke-${Date.now()}`;
  const uri = `viking://resources/smoke/${runId}.md`;
  const parentUri = 'viking://resources/smoke/';
  const content = [
    `# Smoke test document ${runId}`,
    '',
    'This document is written by the v1-stable e2e smoke test harness.',
    'It contains deliberately unique tokens so the find query can assert',
    `round-trip retrieval: ${runId}-MAGIC-STRING-9fa1a2c3.`,
    '',
    'Payload includes several paragraphs so the ingestion handler does',
    'not short-circuit through the SHORT_CONTENT_TOKEN_THRESHOLD bypass.',
    'The content is intentionally mundane so summarisation is deterministic.',
  ].join('\n');

  beforeAll(() => {
    if (skip) return;
  });

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(new URL(path, apiUrl!), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey!,
      },
      body: JSON.stringify(body),
    });
  }

  async function get(path: string): Promise<Response> {
    return fetch(new URL(path, apiUrl!), {
      headers: { 'x-api-key': apiKey! },
    });
  }

  it(
    'round-trips a document through the full pipeline',
    async () => {
      // 1. Ingest
      const contentBase64 = Buffer.from(content, 'utf-8').toString('base64');
      const ingest = await post('resources', {
        uri_prefix: parentUri,
        filename: `${runId}.md`,
        content_base64: contentBase64,
      });
      expect(ingest.status).toBe(200);

      // 2. Wait for rollup (poll parent L0 row via /fs/read at level 0)
      const deadline = Date.now() + ROLLUP_WAIT_MS;
      let rolledUp = false;
      while (Date.now() < deadline) {
        const readParent = await get(
          `fs/read?uri=${encodeURIComponent(parentUri)}&level=0`
        );
        if (readParent.status === 200) {
          const body = (await readParent.json()) as { content?: string };
          if (body.content && body.content.length > 0) {
            rolledUp = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      expect(rolledUp, `parent rollup not observed within ${ROLLUP_WAIT_MS}ms`).toBe(true);

      // 3. Read ingested document at L0, L1, L2
      for (const level of [0, 1, 2]) {
        const read = await get(`fs/read?uri=${encodeURIComponent(uri)}&level=${level}`);
        expect(read.status, `GET /fs/read level=${level}`).toBe(200);
        const body = (await read.json()) as { content?: string };
        expect(body.content, `level ${level} content is non-empty`).toBeTruthy();
      }

      // 4. Find by the unique token in the payload
      const find = await post('search/find', {
        query: `${runId}-MAGIC-STRING-9fa1a2c3`,
        max_results: 5,
        min_score: 0,
      });
      expect(find.status).toBe(200);
      const findBody = (await find.json()) as {
        results: Array<{ uri: string }>;
      };
      const uris = findBody.results.map((r) => r.uri);
      expect(uris).toContain(uri);
    },
    ROLLUP_WAIT_MS + 60_000,
  );
});
