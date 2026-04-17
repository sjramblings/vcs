import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';

mock.module('../../src/lib/config.js', () => ({
  resolveConfig: () =>
    Promise.resolve({ apiUrl: 'https://api.example.com', apiKey: 'test-key-1234', source: 'env' as const }),
}));

const outputCalls = {
  result: [] as unknown[][],
  error: [] as unknown[][],
  errorJson: [] as unknown[][],
};

mock.module('../../src/lib/output.js', () => ({
  result: (...args: unknown[]) => { outputCalls.result.push(args); },
  error: (...args: unknown[]) => { outputCalls.error.push(args); },
  errorJson: (...args: unknown[]) => { outputCalls.errorJson.push(args); },
  status: () => {},
  success: () => {},
}));

const originalFetch = globalThis.fetch;

import { registerSearch } from '../../src/commands/search.js';
import { Command } from '@commander-js/extra-typings';

describe('search command', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    outputCalls.result = [];
    outputCalls.error = [];
    outputCalls.errorJson = [];
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it('registers search command on program', () => {
    const program = new Command();
    registerSearch(program);
    const searchCmd = program.commands.find(c => c.name() === 'search');
    expect(searchCmd).toBeDefined();
    expect(searchCmd!.description()).toBe('Session-aware semantic search');
  });

  it('requires --session option', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('{}', { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output').exitOverride();
    registerSearch(program);

    let threw = false;
    try {
      await program.parseAsync(['search', 'test query'], { from: 'user' });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('sends POST /search/search with query and session_id', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({
        memories: [], resources: [], skills: [],
        query_plan: [], trajectory: [], reason: null, tokens_saved_estimate: 0,
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerSearch(program);
    await program.parseAsync(['search', 'test', '--session', 'sess-123'], { from: 'user' });

    expect(capturedUrl).toContain('/search/search');
    expect(capturedInit?.method).toBe('POST');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.query).toBe('test');
    expect(body.session_id).toBe('sess-123');
  });

  it('outputs categorized human-readable results', async () => {
    const mockResponse = {
      resources: [{ uri: 'viking://resources/doc1', score: 0.9, level: 0, abstract: 'Resource abstract' }],
      memories: [{ uri: 'viking://user/memories/m1', score: 0.8, level: 0, abstract: 'Memory abstract' }],
      skills: [],
      query_plan: [],
      trajectory: [],
      reason: null,
      tokens_saved_estimate: 100,
    };
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerSearch(program);
    await program.parseAsync(['search', 'test', '--session', 'sess-123'], { from: 'user' });

    const written = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(written).toContain('Resources:');
    expect(written).toContain('0.90');
    expect(written).toContain('viking://resources/doc1');
    expect(written).toContain('Resource abstract');
    expect(written).toContain('Memories:');
    expect(written).toContain('0.80');
    expect(written).toContain('Memory abstract');
    expect(written).not.toContain('Skills:');
  });

  it('outputs JSON with --json flag', async () => {
    const mockResponse = {
      resources: [{ uri: 'viking://resources/doc1', score: 0.9, level: 0, abstract: 'Test' }],
      memories: [], skills: [],
      query_plan: [], trajectory: [], reason: null, tokens_saved_estimate: 50,
    };
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerSearch(program);
    await program.parseAsync(['--json', 'search', 'test', '--session', 'sess-123'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    expect(outputCalls.result[0]![1]).toBe(true);
  });

  it('prints No results found when all categories empty', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({
        memories: [], resources: [], skills: [],
        query_plan: [], trajectory: [], reason: null, tokens_saved_estimate: 0,
      }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerSearch(program);
    await program.parseAsync(['search', 'test', '--session', 'sess-123'], { from: 'user' });

    const stderrWritten = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrWritten).toContain('No results found');
  });

  it('exits 1 on 400 response', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerSearch(program);
    await program.parseAsync(['search', 'test', '--session', 'sess-123'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 2 on network error', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerSearch(program);
    await program.parseAsync(['search', 'test', '--session', 'sess-123'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
