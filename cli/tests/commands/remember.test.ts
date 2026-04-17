import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';

mock.module('../../src/lib/config.js', () => ({
  resolveConfig: () =>
    Promise.resolve({ apiUrl: 'https://api.example.com', apiKey: 'test-key-1234', source: 'env' as const }),
}));

const outputCalls = {
  result: [] as unknown[][],
  error: [] as unknown[][],
  errorJson: [] as unknown[][],
  success: [] as unknown[][],
};

mock.module('../../src/lib/output.js', () => ({
  result: (...args: unknown[]) => { outputCalls.result.push(args); },
  error: (...args: unknown[]) => { outputCalls.error.push(args); },
  errorJson: (...args: unknown[]) => { outputCalls.errorJson.push(args); },
  status: () => {},
  success: (...args: unknown[]) => { outputCalls.success.push(args); },
}));

const originalFetch = globalThis.fetch;

import { registerRemember } from '../../src/commands/remember.js';
import { Command } from '@commander-js/extra-typings';

describe('remember command', () => {
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
    outputCalls.success = [];
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it('registers remember command on program', () => {
    const program = new Command();
    registerRemember(program);
    const rememberCmd = program.commands.find(c => c.name() === 'remember');
    expect(rememberCmd).toBeDefined();
    expect(rememberCmd!.description()).toBe('Store a memory in Viking Context Service');
  });

  it('sends POST /resources with default general category', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({
        status: 'ok', uri: 'viking://user/memories/general/2026-03-25t14-30-00.md', processing_status: 'complete',
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRemember(program);
    await program.parseAsync(['remember', 'test memory text'], { from: 'user' });

    expect(capturedUrl).toContain('/resources');
    expect(capturedInit?.method).toBe('POST');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.uri_prefix).toBe('viking://user/memories/general/');
    expect(body.content_base64).toBe(Buffer.from('test memory text').toString('base64'));
    expect(body.filename).toMatch(/^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}\.md$/);
  });

  it('uses custom category in URI prefix', async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({
        status: 'ok', uri: 'viking://user/memories/preferences/2026-03-25t14-30-00.md', processing_status: 'complete',
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRemember(program);
    await program.parseAsync(['remember', 'text', '--category', 'preferences'], { from: 'user' });

    expect(capturedBody.uri_prefix).toBe('viking://user/memories/preferences/');
  });

  it('calls success with remembered URI', async () => {
    const mockResponse = {
      status: 'ok',
      uri: 'viking://user/memories/general/2026-03-25t14-30-00.md',
      processing_status: 'complete',
    };
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRemember(program);
    await program.parseAsync(['remember', 'test text'], { from: 'user' });

    expect(outputCalls.success.length).toBe(1);
    expect(String(outputCalls.success[0]![0])).toContain('viking://user/memories/general/2026-03-25t14-30-00.md');
  });

  it('outputs JSON with --json flag', async () => {
    const mockResponse = {
      status: 'ok',
      uri: 'viking://user/memories/general/2026-03-25t14-30-00.md',
      processing_status: 'complete',
    };
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRemember(program);
    await program.parseAsync(['--json', 'remember', 'text'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    expect(outputCalls.result[0]![1]).toBe(true);
  });

  it('exits 1 on 400 response', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRemember(program);
    await program.parseAsync(['remember', 'test'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 2 on network error', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRemember(program);
    await program.parseAsync(['remember', 'test'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('generates filename matching server regex', async () => {
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({
        status: 'ok', uri: 'viking://user/memories/general/test.md', processing_status: 'complete',
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRemember(program);
    await program.parseAsync(['remember', 'test'], { from: 'user' });

    const filename = capturedBody.filename as string;
    expect(filename).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });
});
