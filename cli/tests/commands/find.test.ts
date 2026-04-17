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

import { registerFind } from '../../src/commands/find.js';
import { Command } from '@commander-js/extra-typings';

describe('find command', () => {
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

  it('registers find command on program', () => {
    const program = new Command();
    registerFind(program);
    const findCmd = program.commands.find(c => c.name() === 'find');
    expect(findCmd).toBeDefined();
    expect(findCmd!.description()).toBe('Stateless semantic search');
  });

  it('sends POST /search/find with query and default options', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ results: [], trajectory: [], tokens_saved_estimate: 0 }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['find', 'test query'], { from: 'user' });

    expect(capturedUrl).toContain('/search/find');
    expect(capturedInit?.method).toBe('POST');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.query).toBe('test query');
    expect(body.max_results).toBe(5);
    expect(body.min_score).toBe(0.2);
  });

  it('passes --scope option to API body', async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({ results: [], trajectory: [], tokens_saved_estimate: 0 }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['find', 'test', '--scope', 'viking://resources/'], { from: 'user' });

    expect(capturedBody.scope).toBe('viking://resources/');
  });

  it('passes custom --max-results and --min-score as numbers', async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({ results: [], trajectory: [], tokens_saved_estimate: 0 }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['find', 'test', '--max-results', '10', '--min-score', '0.5'], { from: 'user' });

    expect(capturedBody.max_results).toBe(10);
    expect(typeof capturedBody.max_results).toBe('number');
    expect(capturedBody.min_score).toBe(0.5);
    expect(typeof capturedBody.min_score).toBe('number');
  });

  it('outputs human-readable scored results', async () => {
    const mockResults = {
      results: [
        { uri: 'viking://resources/doc1', score: 0.85, level: 0, abstract: 'Abstract text here' },
        { uri: 'viking://resources/doc2', score: 0.72, level: 0, abstract: 'Another abstract' },
      ],
      trajectory: [],
      tokens_saved_estimate: 100,
    };
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(mockResults), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['find', 'test'], { from: 'user' });

    const written = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(written).toContain('0.85');
    expect(written).toContain('viking://resources/doc1');
    expect(written).toContain('Abstract text here');
    expect(written).toContain('0.72');
    expect(written).toContain('viking://resources/doc2');
    expect(written).toContain('Another abstract');
  });

  it('outputs JSON with --json flag', async () => {
    const mockResults = {
      results: [{ uri: 'viking://resources/doc1', score: 0.85, level: 0, abstract: 'Test' }],
      trajectory: [],
      tokens_saved_estimate: 50,
    };
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(mockResults), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['--json', 'find', 'test'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    expect(outputCalls.result[0]![1]).toBe(true);
  });

  it('prints No results found to stderr on empty results', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ results: [], trajectory: [], tokens_saved_estimate: 0 }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['find', 'test'], { from: 'user' });

    const stderrWritten = stderrSpy.mock.calls.map(c => c[0]).join('');
    expect(stderrWritten).toContain('No results found');
  });

  it('exits 1 on 400 response', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['find', 'test'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 2 on network error', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerFind(program);
    await program.parseAsync(['find', 'test'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
