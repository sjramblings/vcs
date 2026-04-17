import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CliError } from '../../src/lib/errors';

// We need to mock resolveConfig and fetch before importing client
// Use Bun.env to provide config via env vars instead of mocking the module
describe('apiCall', () => {
  let origUrl: string | undefined;
  let origKey: string | undefined;
  let origFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    origUrl = Bun.env.VCS_API_URL;
    origKey = Bun.env.VCS_API_KEY;
    origFetch = globalThis.fetch;
    fetchCalls = [];

    Bun.env.VCS_API_URL = 'https://api.test.com';
    Bun.env.VCS_API_KEY = 'test-api-key-123';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origUrl !== undefined) {
      Bun.env.VCS_API_URL = origUrl;
    } else {
      delete Bun.env.VCS_API_URL;
    }
    if (origKey !== undefined) {
      Bun.env.VCS_API_KEY = origKey;
    } else {
      delete Bun.env.VCS_API_KEY;
    }
  });

  test('sends GET request with correct URL and headers', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: input.toString(), init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    // Dynamic import to pick up mocked fetch
    const { apiCall } = await import('../../src/lib/client');
    await apiCall('/fs/ls');

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe('https://api.test.com/fs/ls');
    expect(fetchCalls[0]!.init.method).toBe('GET');
    expect((fetchCalls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('test-api-key-123');
    expect((fetchCalls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  test('sends POST with JSON body', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: input.toString(), init: init! });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const { apiCall } = await import('../../src/lib/client');
    await apiCall('/data', { method: 'POST', body: { data: 1 } });

    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect(fetchCalls[0]!.init.body).toBe('{"data":1}');
  });

  test('retries once on 500 response', async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response('error', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const { apiCall } = await import('../../src/lib/client');
    const response = await apiCall('/test');

    expect(callCount).toBe(2);
    expect(response.status).toBe(200);
  });

  test('does NOT retry on 400 response', async () => {
    let callCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      callCount++;
      return new Response('bad request', { status: 400 });
    }) as typeof fetch;

    const { apiCall } = await import('../../src/lib/client');
    const response = await apiCall('/test');

    expect(callCount).toBe(1);
    expect(response.status).toBe(400);
  });

  test('passes timeout to AbortSignal', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const { apiCall } = await import('../../src/lib/client');
    await apiCall('/test', { timeout: 5000 });

    expect(capturedSignal).toBeDefined();
  });

  test('accepts custom timeout', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const { apiCall } = await import('../../src/lib/client');
    // Should not throw - just verifies custom timeout is accepted
    const response = await apiCall('/test', { timeout: 60000 });
    expect(response.status).toBe(200);
  });
});
