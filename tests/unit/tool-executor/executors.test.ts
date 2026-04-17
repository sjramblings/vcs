import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock api-client
vi.mock('../../../src/lambdas/mcp-tools/lib/api-client', () => ({
  callApi: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock Logger (imported by api-client and executors)
vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  }),
}));

import { callApi } from '../../../src/lambdas/mcp-tools/lib/api-client';
import { executeFilesystem } from '../../../src/lambdas/mcp-tools/executors/filesystem';
import { executeSearch } from '../../../src/lambdas/mcp-tools/executors/search';
import { executeIngestion } from '../../../src/lambdas/mcp-tools/executors/ingestion';
import { executeSession } from '../../../src/lambdas/mcp-tools/executors/session';

const mockCallApi = vi.mocked(callApi);

beforeEach(() => {
  vi.clearAllMocks();
  mockCallApi.mockResolvedValue({ ok: true });
});

describe('filesystem executor (TE-03)', () => {
  it('read calls GET /fs/read with uri and level', async () => {
    await executeFilesystem('read', { uri: 'viking://test', level: 2 });
    expect(mockCallApi).toHaveBeenCalledWith('GET', '/fs/read', undefined, {
      uri: 'viking://test',
      level: '2',
    });
  });

  it('read defaults level to 0', async () => {
    await executeFilesystem('read', { uri: 'viking://test' });
    expect(mockCallApi).toHaveBeenCalledWith('GET', '/fs/read', undefined, {
      uri: 'viking://test',
      level: '0',
    });
  });

  it('ls calls GET /fs/ls with uri', async () => {
    await executeFilesystem('ls', { uri: 'viking://test' });
    expect(mockCallApi).toHaveBeenCalledWith('GET', '/fs/ls', undefined, {
      uri: 'viking://test',
    });
  });

  it('tree calls GET /fs/tree with optional params', async () => {
    await executeFilesystem('tree', { uri: 'viking://test', depth: 5 });
    expect(mockCallApi).toHaveBeenCalledWith('GET', '/fs/tree', undefined, {
      uri: 'viking://test',
      depth: '5',
    });
  });

  it('tree works without uri param', async () => {
    await executeFilesystem('tree', {});
    expect(mockCallApi).toHaveBeenCalledWith('GET', '/fs/tree', undefined, {});
  });

  it('returns callApi result directly', async () => {
    mockCallApi.mockResolvedValueOnce({ children: ['a', 'b'] });
    const result = await executeFilesystem('ls', { uri: 'viking://test' });
    expect(result).toEqual({ children: ['a', 'b'] });
  });
});

describe('search executor (TE-04)', () => {
  it('find calls POST /search/find with query and optional params', async () => {
    await executeSearch('find', {
      query: 'auth',
      scope: 'viking://resources/',
      max_results: 10,
    });
    expect(mockCallApi).toHaveBeenCalledWith('POST', '/search/find', {
      query: 'auth',
      scope: 'viking://resources/',
      max_results: 10,
    });
  });

  it('find defaults max_results to 5', async () => {
    await executeSearch('find', { query: 'auth' });
    expect(mockCallApi).toHaveBeenCalledWith('POST', '/search/find', {
      query: 'auth',
      scope: undefined,
      max_results: 5,
    });
  });

  it('search calls POST /search/search with session_id', async () => {
    await executeSearch('search', {
      query: 'auth',
      session_id: 'sess-123',
      max_results: 3,
    });
    expect(mockCallApi).toHaveBeenCalledWith('POST', '/search/search', {
      query: 'auth',
      session_id: 'sess-123',
      max_results: 3,
    });
  });
});

describe('ingestion executor (TE-05)', () => {
  it('base64-encodes content before calling API', async () => {
    await executeIngestion({
      content: 'Hello World',
      uri_prefix: 'viking://test/',
      filename: 'doc.md',
    });
    expect(mockCallApi).toHaveBeenCalledWith('POST', '/resources', {
      content_base64: 'SGVsbG8gV29ybGQ=',
      uri_prefix: 'viking://test/',
      filename: 'doc.md',
    });
  });

  it('passes uri_prefix and filename', async () => {
    await executeIngestion({
      content: 'data',
      uri_prefix: 'viking://docs/',
      filename: 'readme.md',
    });
    const body = mockCallApi.mock.calls[0][2] as Record<string, unknown>;
    expect(body.uri_prefix).toBe('viking://docs/');
    expect(body.filename).toBe('readme.md');
  });

  it('includes instruction when provided', async () => {
    await executeIngestion({
      content: 'data',
      uri_prefix: 'viking://test/',
      filename: 'doc.md',
      instruction: 'Extract key points',
    });
    const body = mockCallApi.mock.calls[0][2] as Record<string, unknown>;
    expect(body.instruction).toBe('Extract key points');
  });

  it('omits instruction when not provided', async () => {
    await executeIngestion({
      content: 'data',
      uri_prefix: 'viking://test/',
      filename: 'doc.md',
    });
    const body = mockCallApi.mock.calls[0][2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('instruction');
  });
});

describe('session executor (TE-06, TE-07)', () => {
  it('create_session calls POST /sessions with no body', async () => {
    mockCallApi.mockResolvedValueOnce({ session_id: '1711900000000', status: 'active' });
    await executeSession('create_session', {});
    expect(mockCallApi).toHaveBeenCalledWith('POST', '/sessions');
  });

  it('create_session returns only { session_id }', async () => {
    mockCallApi.mockResolvedValueOnce({
      session_id: '1711900000000',
      status: 'active',
    });
    const result = await executeSession('create_session', {});
    expect(result).toEqual({ session_id: '1711900000000' });
    expect(result).not.toHaveProperty('status');
  });

  it('add_message calls POST /sessions/{id}/messages', async () => {
    await executeSession('add_message', {
      session_id: 'sess-1',
      role: 'user',
      content: 'hello',
    });
    expect(mockCallApi).toHaveBeenCalledWith(
      'POST',
      '/sessions/sess-1/messages',
      {
        role: 'user',
        parts: [{ type: 'text', content: 'hello' }],
      },
    );
  });

  it('used calls POST /sessions/{id}/used with uris', async () => {
    await executeSession('used', {
      session_id: 'sess-1',
      uris: ['viking://a'],
    });
    expect(mockCallApi).toHaveBeenCalledWith(
      'POST',
      '/sessions/sess-1/used',
      { uris: ['viking://a'] },
    );
  });

  it('used includes optional skill', async () => {
    await executeSession('used', {
      session_id: 'sess-1',
      uris: ['viking://a'],
      skill: 'code-review',
    });
    const body = mockCallApi.mock.calls[0][2] as Record<string, unknown>;
    expect(body.skill).toBe('code-review');
  });

  it('commit_session calls POST /sessions/{id}/commit', async () => {
    await executeSession('commit_session', { session_id: 'sess-1' });
    expect(mockCallApi).toHaveBeenCalledWith(
      'POST',
      '/sessions/sess-1/commit',
    );
  });
});

describe('error handling', () => {
  it('executor errors include tool name in message', async () => {
    mockCallApi.mockRejectedValueOnce(new Error('404 Not Found'));
    await expect(
      executeFilesystem('read', { uri: 'viking://x' }),
    ).rejects.toThrow(/read/);
    // Reset and test again to verify both tool name and original error
    mockCallApi.mockRejectedValueOnce(new Error('404 Not Found'));
    await expect(
      executeFilesystem('read', { uri: 'viking://x' }),
    ).rejects.toThrow(/404 Not Found/);
  });
});
