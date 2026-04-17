import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';

// Mock all executor modules
vi.mock('../../../src/lambdas/mcp-tools/executors/filesystem', () => ({
  executeFilesystem: vi.fn().mockResolvedValue({ content: 'file-data' }),
}));
vi.mock('../../../src/lambdas/mcp-tools/executors/search', () => ({
  executeSearch: vi.fn().mockResolvedValue({ results: [] }),
}));
vi.mock('../../../src/lambdas/mcp-tools/executors/ingestion', () => ({
  executeIngestion: vi.fn().mockResolvedValue({ uri: 'viking://test' }),
}));
vi.mock('../../../src/lambdas/mcp-tools/executors/session', () => ({
  executeSession: vi.fn().mockResolvedValue({ session_id: '123' }),
}));

// Mock Powertools - use function keyword for constructor compatibility
vi.mock('@aws-lambda-powertools/logger', () => ({
  Logger: vi.fn(function () {
    return { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  }),
}));
vi.mock('@aws-lambda-powertools/tracer', () => ({
  Tracer: vi.fn(function () {
    return {
      getSegment: vi.fn().mockReturnValue({
        addNewSubsegment: vi.fn().mockReturnValue({ close: vi.fn() }),
      }),
      setSegment: vi.fn(),
      annotateColdStart: vi.fn(),
      putAnnotation: vi.fn(),
      addErrorAsMetadata: vi.fn(),
    };
  }),
}));

import { handler } from '../../../src/lambdas/mcp-tools/handler';
import { executeFilesystem } from '../../../src/lambdas/mcp-tools/executors/filesystem';
import { executeSearch } from '../../../src/lambdas/mcp-tools/executors/search';
import { executeIngestion } from '../../../src/lambdas/mcp-tools/executors/ingestion';
import { executeSession } from '../../../src/lambdas/mcp-tools/executors/session';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';

const mockExecuteFilesystem = vi.mocked(executeFilesystem);
const mockExecuteSearch = vi.mocked(executeSearch);
const mockExecuteIngestion = vi.mocked(executeIngestion);
const mockExecuteSession = vi.mocked(executeSession);

/**
 * Create a mock Lambda Context with bedrockAgentCoreToolName set.
 */
function mockContext(toolName: string): Context {
  return {
    clientContext: {
      custom: { bedrockAgentCoreToolName: toolName },
      client: {
        installationId: '',
        appTitle: '',
        appVersionName: '',
        appVersionCode: '',
        appPackageName: '',
      },
      env: {
        platformVersion: '',
        platform: '',
        make: '',
        model: '',
        locale: '',
      },
    },
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'vcs-mcp-tools',
    functionVersion: '$LATEST',
    invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:vcs-mcp-tools',
    memoryLimitInMB: '256',
    awsRequestId: 'test-request-id',
    logGroupName: '/aws/lambda/vcs-mcp-tools',
    logStreamName: '2026/03/31/[$LATEST]abc123',
    getRemainingTimeInMillis: () => 30000,
    done: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tool name extraction (TE-01)', () => {
  it('extracts tool name from context.clientContext.custom.bedrockAgentCoreToolName', async () => {
    await handler({ uri: 'viking://test' }, mockContext('vcs___read'));
    expect(mockExecuteFilesystem).toHaveBeenCalled();
  });

  it('handles missing clientContext gracefully', async () => {
    const ctx = { ...mockContext('read'), clientContext: undefined } as unknown as Context;
    const result = await handler({}, ctx);
    expect(result).toHaveProperty('error', true);
    expect(result.message).toContain('Unknown tool');
  });

  it('handles missing bedrockAgentCoreToolName', async () => {
    const ctx = {
      ...mockContext('read'),
      clientContext: { custom: {}, client: {}, env: {} },
    } as unknown as Context;
    const result = await handler({}, ctx);
    expect(result).toHaveProperty('error', true);
    expect(result.message).toContain('Unknown tool');
  });
});

describe('prefix stripping (TE-02)', () => {
  it('strips vcs___ prefix from tool name', async () => {
    await handler({ uri: 'viking://test' }, mockContext('vcs___read'));
    expect(mockExecuteFilesystem).toHaveBeenCalledWith('read', { uri: 'viking://test' });
  });

  it('handles tool name without prefix', async () => {
    await handler({ uri: 'viking://test' }, mockContext('read'));
    expect(mockExecuteFilesystem).toHaveBeenCalledWith('read', { uri: 'viking://test' });
  });

  it('handles multiple ___ delimiters by taking after first', async () => {
    // 'vcs___some___thing' should strip to 'some___thing'
    const result = await handler({}, mockContext('vcs___some___thing'));
    // 'some___thing' is not a known tool, so it should return unknown error
    expect(result).toHaveProperty('error', true);
    expect(result.message).toContain('Unknown tool: some___thing');
  });
});

describe('dispatch routing', () => {
  it('routes read to filesystem executor', async () => {
    await handler({ uri: 'viking://test' }, mockContext('vcs___read'));
    expect(mockExecuteFilesystem).toHaveBeenCalledWith('read', { uri: 'viking://test' });
  });

  it('routes ls to filesystem executor', async () => {
    await handler({ uri: 'viking://test' }, mockContext('vcs___ls'));
    expect(mockExecuteFilesystem).toHaveBeenCalledWith('ls', { uri: 'viking://test' });
  });

  it('routes tree to filesystem executor', async () => {
    await handler({}, mockContext('vcs___tree'));
    expect(mockExecuteFilesystem).toHaveBeenCalledWith('tree', {});
  });

  it('routes find to search executor', async () => {
    await handler({ query: 'auth' }, mockContext('vcs___find'));
    expect(mockExecuteSearch).toHaveBeenCalledWith('find', { query: 'auth' });
  });

  it('routes search to search executor', async () => {
    await handler({ query: 'auth', session_id: 's1' }, mockContext('vcs___search'));
    expect(mockExecuteSearch).toHaveBeenCalledWith('search', { query: 'auth', session_id: 's1' });
  });

  it('routes ingest to ingestion executor', async () => {
    const input = { content: 'data', uri_prefix: 'viking://test/', filename: 'doc.md' };
    await handler(input, mockContext('vcs___ingest'));
    expect(mockExecuteIngestion).toHaveBeenCalledWith(input);
  });

  it('routes create_session to session executor', async () => {
    await handler({}, mockContext('vcs___create_session'));
    expect(mockExecuteSession).toHaveBeenCalledWith('create_session', {});
  });

  it('routes add_message to session executor', async () => {
    const input = { session_id: 's1', role: 'user', content: 'hello' };
    await handler(input, mockContext('vcs___add_message'));
    expect(mockExecuteSession).toHaveBeenCalledWith('add_message', input);
  });

  it('routes used to session executor', async () => {
    const input = { session_id: 's1', uris: ['viking://a'] };
    await handler(input, mockContext('vcs___used'));
    expect(mockExecuteSession).toHaveBeenCalledWith('used', input);
  });

  it('routes commit_session to session executor', async () => {
    const input = { session_id: 's1' };
    await handler(input, mockContext('vcs___commit_session'));
    expect(mockExecuteSession).toHaveBeenCalledWith('commit_session', input);
  });

  it('returns error for unknown tool', async () => {
    const result = await handler({}, mockContext('vcs___unknown'));
    expect(result).toEqual({ error: true, message: 'Unknown tool: unknown' });
  });
});

describe('error handling ', () => {
  it('catches executor errors and returns error object', async () => {
    mockExecuteFilesystem.mockRejectedValueOnce(new Error('API 500'));
    const result = await handler({ uri: 'viking://test' }, mockContext('vcs___read'));
    expect(result).toHaveProperty('error', true);
    expect(result.message).toBeDefined();
  });

  it('includes tool name in error message', async () => {
    mockExecuteFilesystem.mockRejectedValueOnce(new Error('API 500'));
    const result = await handler({ uri: 'viking://test' }, mockContext('vcs___read'));
    expect(result.message).toContain('read');
    expect(result.message).toContain('API 500');
  });
});

// Capture constructor call args before any clearAllMocks resets them.
// Logger and Tracer are constructed at module load time (top-level const).
const loggerConstructorArgs = vi.mocked(Logger).mock.calls.map((c) => c[0]);
const tracerConstructorArgs = vi.mocked(Tracer).mock.calls.map((c) => c[0]);

describe('observability (TE-08)', () => {
  it('initializes Logger with serviceName vcs-mcp-tools', () => {
    expect(loggerConstructorArgs).toContainEqual({ serviceName: 'vcs-mcp-tools' });
  });

  it('initializes Tracer with serviceName vcs-mcp-tools', () => {
    expect(tracerConstructorArgs).toContainEqual({ serviceName: 'vcs-mcp-tools' });
  });
});
