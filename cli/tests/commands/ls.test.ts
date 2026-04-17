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

import { registerLs } from '../../src/commands/ls.js';
import { Command } from '@commander-js/extra-typings';

describe('ls command', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    outputCalls.result = [];
    outputCalls.error = [];
    outputCalls.errorJson = [];
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it('registers ls command on program', () => {
    const program = new Command();
    registerLs(program);
    const cmd = program.commands.find(c => c.name() === 'ls');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe('List children of a directory URI');
  });

  it('calls GET /fs/ls with uri', async () => {
    let capturedUrl = '';
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({
        items: [{ uri: 'viking://a', is_directory: true, context_type: 'dir', created_at: '2026-01-01', updated_at: '2026-01-01' }],
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerLs(program);
    await program.parseAsync(['ls', 'viking://test'], { from: 'user' });

    expect(capturedUrl).toContain('/fs/ls');
    expect(capturedUrl).toContain('uri=viking%3A%2F%2Ftest');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('displays items as aligned columns', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({
        items: [{ uri: 'viking://a', is_directory: true, context_type: 'dir', created_at: '2026-01-01', updated_at: '2026-01-01' }],
      }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerLs(program);
    await program.parseAsync(['ls', 'viking://test'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    expect(outputCalls.result[0]![1]).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('auto-paginates when nextToken present', async () => {
    let callCount = 0;
    globalThis.fetch = ((url: string) => {
      callCount++;
      if (callCount === 1) {
        expect(url).not.toContain('nextToken');
        return Promise.resolve(new Response(JSON.stringify({
          items: [{ uri: 'viking://a', is_directory: true, context_type: 'dir', created_at: '2026-01-01', updated_at: '2026-01-01' }],
          nextToken: 'tok1',
        }), { status: 200 }));
      }
      expect(url).toContain('nextToken=tok1');
      return Promise.resolve(new Response(JSON.stringify({
        items: [{ uri: 'viking://b', is_directory: false, context_type: 'document', created_at: '2026-01-02', updated_at: '2026-01-02' }],
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerLs(program);
    await program.parseAsync(['ls', 'viking://test'], { from: 'user' });

    expect(callCount).toBe(2);
    expect(outputCalls.result.length).toBe(1);
    const items = outputCalls.result[0]![0] as unknown[];
    expect(items.length).toBe(2);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints No items found on empty results', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerLs(program);
    await program.parseAsync(['ls', 'viking://empty'], { from: 'user' });

    expect(stderrSpy).toHaveBeenCalledWith('No items found.\n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('outputs JSON with --json flag', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({
        items: [{ uri: 'viking://a', is_directory: true, context_type: 'dir', created_at: '2026-01-01', updated_at: '2026-01-01' }],
      }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerLs(program);
    await program.parseAsync(['--json', 'ls', 'viking://test'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    expect(outputCalls.result[0]![1]).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 on 404', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerLs(program);
    await program.parseAsync(['ls', 'viking://missing'], { from: 'user' });

    expect(outputCalls.error.length).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
