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

import { registerRead } from '../../src/commands/read.js';
import { Command } from '@commander-js/extra-typings';

describe('read command', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    outputCalls.result = [];
    outputCalls.error = [];
    outputCalls.errorJson = [];
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it('registers read command on program', () => {
    const program = new Command();
    registerRead(program);
    const cmd = program.commands.find(c => c.name() === 'read');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe('Read content at specified detail level');
  });

  it('calls GET /fs/read with uri and default level 2', async () => {
    let capturedUrl = '';
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ uri: 'viking://test', level: 2, content: 'hello', tokens: 5 }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRead(program);
    await program.parseAsync(['read', 'viking://test'], { from: 'user' });

    expect(capturedUrl).toContain('/fs/read');
    expect(capturedUrl).toContain('uri=viking%3A%2F%2Ftest');
    expect(capturedUrl).toContain('level=2');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('calls GET /fs/read with custom --level 0', async () => {
    let capturedUrl = '';
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ uri: 'viking://test', level: 0, content: 'summary', tokens: 2 }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRead(program);
    await program.parseAsync(['read', '--level', '0', 'viking://test'], { from: 'user' });

    expect(capturedUrl).toContain('level=0');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('writes raw content to stdout in human mode', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ uri: 'viking://test', level: 2, content: 'hello world', tokens: 5 }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRead(program);
    await program.parseAsync(['read', 'viking://test'], { from: 'user' });

    expect(stdoutSpy).toHaveBeenCalledWith('hello world');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('outputs JSON with --json flag', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ uri: 'viking://test', level: 2, content: 'data', tokens: 3 }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRead(program);
    await program.parseAsync(['--json', 'read', 'viking://test'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    const data = outputCalls.result[0]![0] as Record<string, unknown>;
    expect(data.uri).toBe('viking://test');
    expect(data.content).toBe('data');
    expect(outputCalls.result[0]![1]).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 on 404 response', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRead(program);
    await program.parseAsync(['read', 'viking://missing'], { from: 'user' });

    expect(outputCalls.error.length).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 2 on network error', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerRead(program);
    await program.parseAsync(['read', 'viking://test'], { from: 'user' });

    expect(outputCalls.error.length).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
