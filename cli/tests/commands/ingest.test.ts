import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

mock.module('../../src/lib/config.js', () => ({
  resolveConfig: () =>
    Promise.resolve({ apiUrl: 'https://api.example.com', apiKey: 'test-key-1234', source: 'env' as const }),
}));

const outputCalls = {
  result: [] as unknown[][],
  error: [] as unknown[][],
  errorJson: [] as unknown[][],
  success: [] as unknown[][],
  status: [] as unknown[][],
};

mock.module('../../src/lib/output.js', () => ({
  result: (...args: unknown[]) => { outputCalls.result.push(args); },
  error: (...args: unknown[]) => { outputCalls.error.push(args); },
  errorJson: (...args: unknown[]) => { outputCalls.errorJson.push(args); },
  success: (...args: unknown[]) => { outputCalls.success.push(args); },
  status: (...args: unknown[]) => { outputCalls.status.push(args); },
}));

const originalFetch = globalThis.fetch;

import { registerIngest, normaliseFilename } from '../../src/commands/ingest.js';
import { Command } from '@commander-js/extra-typings';

describe('ingest command', () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;
  let tempDir: string | undefined;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    stderrSpy = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    outputCalls.result = [];
    outputCalls.error = [];
    outputCalls.errorJson = [];
    outputCalls.success = [];
    outputCalls.status = [];
  });

  afterEach(async () => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    globalThis.fetch = originalFetch;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('registers ingest command on program', () => {
    const program = new Command();
    registerIngest(program);
    const ingestCmd = program.commands.find(c => c.name() === 'ingest');
    expect(ingestCmd).toBeDefined();
    expect(ingestCmd!.description()).toBe('Ingest files into Viking Context Service');
  });

  describe('normaliseFilename', () => {
    it('lowercases and replaces invalid characters', () => {
      expect(normaliseFilename('My File (v2).md')).toBe('my-file-v2-.md');
    });

    it('collapses multiple hyphens', () => {
      expect(normaliseFilename('a---b.txt')).toBe('a-b.txt');
    });

    it('strips leading non-alphanumeric characters', () => {
      expect(normaliseFilename('---file.md')).toBe('file.md');
    });

    it('returns unnamed for empty result', () => {
      expect(normaliseFilename('---')).toBe('unnamed');
    });

    it('preserves valid filenames', () => {
      expect(normaliseFilename('valid-file.md')).toBe('valid-file.md');
    });
  });

  describe('single file ingestion (INGST-01)', () => {
    it('sends POST /resources with base64 content and default prefix', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));
      const filePath = path.join(tempDir, 'test.md');
      await writeFile(filePath, 'Hello World');

      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = ((_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok', uri: 'viking://resources/test.md', processing_status: 'complete' }), { status: 201 }),
        );
      }) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', filePath], { from: 'user' });

      expect(capturedBody.content_base64).toBe(Buffer.from('Hello World').toString('base64'));
      expect(capturedBody.uri_prefix).toBe('viking://resources/');
      expect(capturedBody.filename).toBe('test.md');
      expect(outputCalls.success.length).toBeGreaterThanOrEqual(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('normalises filename to match server regex', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));
      const filePath = path.join(tempDir, 'My File (v2).md');
      await writeFile(filePath, 'content');

      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = ((_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok', uri: 'viking://resources/my-file-v2-.md', processing_status: 'complete' }), { status: 201 }),
        );
      }) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', filePath], { from: 'user' });

      expect(capturedBody.filename).toBe('my-file-v2-.md');
    });

    it('exits 1 on 400 response', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));
      const filePath = path.join(tempDir, 'test.md');
      await writeFile(filePath, 'content');

      globalThis.fetch = (() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 }))
      ) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', filePath], { from: 'user' });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 on file not found', async () => {
      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', '/nonexistent/path/file.md'], { from: 'user' });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(outputCalls.error.length).toBeGreaterThanOrEqual(1);
      expect(String(outputCalls.error[0]![0])).toContain('File not found');
    });

    it('outputs JSON with --json flag on single file', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));
      const filePath = path.join(tempDir, 'test.md');
      await writeFile(filePath, 'content');

      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ status: 'ok', uri: 'viking://resources/test.md', processing_status: 'complete' }), { status: 201 }),
        )
      ) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['--json', 'ingest', filePath], { from: 'user' });

      expect(outputCalls.result.length).toBe(1);
      expect(outputCalls.result[0]![1]).toBe(true);
    });
  });

  describe('stdin ingestion (INGST-02)', () => {
    it('errors when stdin mode without --filename', async () => {
      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', '-'], { from: 'user' });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(outputCalls.error.length).toBeGreaterThanOrEqual(1);
      expect(String(outputCalls.error[0]![0])).toContain('--filename is required');
    });
  });

  describe('recursive directory ingestion (INGST-03)', () => {
    it('errors when directory without --recursive flag', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', tempDir], { from: 'user' });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(outputCalls.error.length).toBeGreaterThanOrEqual(1);
      expect(String(outputCalls.error[0]![0])).toContain('--recursive');
    });

    it('skips dotfiles and non-text extensions', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));
      await writeFile(path.join(tempDir, '.hidden'), 'secret');
      await writeFile(path.join(tempDir, 'binary.exe'), 'binary');
      await writeFile(path.join(tempDir, 'valid.md'), 'content');

      let fetchCount = 0;
      globalThis.fetch = ((_url: string, _init?: RequestInit) => {
        fetchCount++;
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok', uri: 'viking://resources/valid.md', processing_status: 'complete' }), { status: 201 }),
        );
      }) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', tempDir, '--recursive'], { from: 'user' });

      expect(fetchCount).toBe(1);
      expect(outputCalls.success.length).toBe(1);
    });

    it('reports no eligible files when directory is empty', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', tempDir, '--recursive'], { from: 'user' });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(outputCalls.error.length).toBeGreaterThanOrEqual(1);
      expect(String(outputCalls.error[0]![0])).toContain('No eligible files');
    });

    it('continues processing after partial failure', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));
      await writeFile(path.join(tempDir, 'a.md'), 'content a');
      await writeFile(path.join(tempDir, 'b.md'), 'content b');

      let callNum = 0;
      globalThis.fetch = ((_url: string, _init?: RequestInit) => {
        callNum++;
        if (callNum === 1) {
          return Promise.resolve(new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok', uri: 'viking://resources/b.md', processing_status: 'complete' }), { status: 201 }),
        );
      }) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', tempDir, '--recursive'], { from: 'user' });

      // One success, one error
      expect(outputCalls.success.length).toBe(1);
      expect(outputCalls.error.length).toBeGreaterThanOrEqual(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('preserves subdirectory structure in URI prefix', async () => {
      tempDir = await mkdtemp(path.join(tmpdir(), 'vcs-ingest-'));
      await mkdir(path.join(tempDir, 'sub'), { recursive: true });
      await writeFile(path.join(tempDir, 'sub', 'nested.md'), 'nested content');

      let capturedBody: Record<string, unknown> = {};
      globalThis.fetch = ((_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ok', uri: 'viking://resources/sub/nested.md', processing_status: 'complete' }), { status: 201 }),
        );
      }) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerIngest(program);
      await program.parseAsync(['ingest', tempDir, '--recursive', '--prefix', 'viking://docs/'], { from: 'user' });

      expect(capturedBody.uri_prefix).toBe('viking://docs/sub/');
      expect(capturedBody.filename).toBe('nested.md');
    });
  });
});
