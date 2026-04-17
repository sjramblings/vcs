import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';

// Mock modules using the paths that the source module resolves to
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

// Keep a ref to real fetch for restore
const originalFetch = globalThis.fetch;

import { registerHealth } from '../../src/commands/health.js';
import { Command } from '@commander-js/extra-typings';

describe('health command', () => {
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    outputCalls.result = [];
    outputCalls.error = [];
    outputCalls.errorJson = [];
  });

  afterEach(() => {
    exitSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it('registers health command on program', () => {
    const program = new Command();
    registerHealth(program);
    const healthCmd = program.commands.find(c => c.name() === 'health');
    expect(healthCmd).toBeDefined();
    expect(healthCmd!.description()).toBe('Check VCS API connectivity');
  });

  it('returns status ok with latency on successful response', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('{}', { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerHealth(program);
    await program.parseAsync(['health'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    const data = outputCalls.result[0]![0] as Record<string, unknown>;
    expect(data.status).toBe('ok');
    expect(typeof data.latency_ms).toBe('number');
    expect(data.endpoint).toBe('https://api.example.com');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 2 on HTTP 500 error', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('', { status: 500 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerHealth(program);
    await program.parseAsync(['health'], { from: 'user' });

    expect(outputCalls.error.length).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('exits 2 on network error', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerHealth(program);
    await program.parseAsync(['health'], { from: 'user' });

    expect(outputCalls.error.length).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('outputs JSON format with --json flag on success', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('{}', { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerHealth(program);
    await program.parseAsync(['--json', 'health'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    const isJson = outputCalls.result[0]![1];
    expect(isJson).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('outputs JSON error with --json flag on failure', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response('', { status: 500 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerHealth(program);
    await program.parseAsync(['--json', 'health'], { from: 'user' });

    expect(outputCalls.errorJson.length).toBe(1);
    expect(outputCalls.errorJson[0]![0]).toBe('HEALTH_FAILED');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
