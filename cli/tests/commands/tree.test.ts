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

import { registerTree } from '../../src/commands/tree.js';
import { Command } from '@commander-js/extra-typings';

describe('tree command', () => {
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

  it('registers tree command on program', () => {
    const program = new Command();
    registerTree(program);
    const cmd = program.commands.find(c => c.name() === 'tree');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe('Show recursive namespace tree');
  });

  it('calls GET /fs/tree with uri and default depth 3', async () => {
    let capturedUrl = '';
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({
        root: { uri: 'viking://test', is_directory: true, children: [] },
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerTree(program);
    await program.parseAsync(['tree', 'viking://test'], { from: 'user' });

    expect(capturedUrl).toContain('/fs/tree');
    expect(capturedUrl).toContain('uri=viking%3A%2F%2Ftest');
    expect(capturedUrl).toContain('depth=3');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('calls GET /fs/tree with custom --depth 5', async () => {
    let capturedUrl = '';
    globalThis.fetch = ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(new Response(JSON.stringify({
        root: { uri: 'viking://test', is_directory: true, children: [] },
      }), { status: 200 }));
    }) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerTree(program);
    await program.parseAsync(['tree', '--depth', '5', 'viking://test'], { from: 'user' });

    expect(capturedUrl).toContain('depth=5');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('renders Unicode tree with box-drawing characters', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({
        root: {
          uri: 'viking://resources',
          is_directory: true,
          children: [
            {
              uri: 'viking://resources/docs',
              is_directory: true,
              children: [
                { uri: 'viking://resources/docs/readme.md', is_directory: false },
              ],
            },
            { uri: 'viking://resources/images', is_directory: true },
          ],
        },
      }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerTree(program);
    await program.parseAsync(['tree', 'viking://resources'], { from: 'user' });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('viking://resources');
    expect(output).toContain('\u251c\u2500\u2500 docs');
    expect(output).toContain('\u2502   \u2514\u2500\u2500 readme.md');
    expect(output).toContain('\u2514\u2500\u2500 images');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('shows full URI for root, leaf names for children', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({
        root: {
          uri: 'viking://resources',
          is_directory: true,
          children: [
            { uri: 'viking://resources/notes', is_directory: true },
          ],
        },
      }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerTree(program);
    await program.parseAsync(['tree', 'viking://resources'], { from: 'user' });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    // Root shows full URI
    expect(output).toContain('viking://resources');
    // Children show leaf name only
    expect(output).toContain('notes');
    // Children do NOT show full URI
    expect(output).not.toContain('\u2514\u2500\u2500 viking://');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('outputs JSON with --json flag', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({
        root: { uri: 'viking://test', is_directory: true, children: [] },
      }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerTree(program);
    await program.parseAsync(['--json', 'tree', 'viking://test'], { from: 'user' });

    expect(outputCalls.result.length).toBe(1);
    expect(outputCalls.result[0]![1]).toBe(true);
    const data = outputCalls.result[0]![0] as Record<string, unknown>;
    expect(data.root).toBeDefined();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('handles root with no children', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({
        root: { uri: 'viking://empty', is_directory: true },
      }), { status: 200 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerTree(program);
    await program.parseAsync(['tree', 'viking://empty'], { from: 'user' });

    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('viking://empty');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 on 404', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }))
    ) as typeof fetch;

    const program = new Command().option('--json', 'JSON output');
    registerTree(program);
    await program.parseAsync(['tree', 'viking://missing'], { from: 'user' });

    expect(outputCalls.error.length).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
