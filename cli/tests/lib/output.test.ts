import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { result, status, success, error, errorJson } from '../../src/lib/output';

describe('output module', () => {
  let stdoutData: string[];
  let stderrData: string[];
  let origStdoutWrite: typeof process.stdout.write;
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stdoutData = [];
    stderrData = [];
    origStdoutWrite = process.stdout.write;
    origStderrWrite = process.stderr.write;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutData.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;

    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrData.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  });

  describe('result', () => {
    test('writes JSON to stdout when isJson=true', () => {
      result({ key: 'val' }, true);
      expect(stdoutData.join('')).toBe('{"key":"val"}\n');
      expect(stderrData).toHaveLength(0);
    });

    test('writes human-readable to stdout when isJson=false', () => {
      result({ key: 'val' }, false);
      const output = stdoutData.join('');
      expect(output).toContain('key');
      expect(output).toContain('val');
      expect(stderrData).toHaveLength(0);
    });

    test('formats key-value with aligned labels', () => {
      result({ name: 'test', status: 'ok', latency_ms: 42 }, false);
      const output = stdoutData.join('');
      expect(output).toContain('name');
      expect(output).toContain('test');
      expect(output).toContain('status');
      expect(output).toContain('ok');
    });
  });

  describe('status', () => {
    test('writes to stderr', () => {
      status('loading...');
      expect(stderrData.join('')).toContain('loading...');
      expect(stdoutData).toHaveLength(0);
    });
  });

  describe('success', () => {
    test('writes checkmark message to stderr', () => {
      success('done');
      const output = stderrData.join('');
      expect(output).toContain('done');
      expect(stdoutData).toHaveLength(0);
    });
  });

  describe('error', () => {
    test('writes error message to stderr', () => {
      error('failed');
      const output = stderrData.join('');
      expect(output).toContain('failed');
      expect(stdoutData).toHaveLength(0);
    });

    test('writes hint to stderr when provided', () => {
      error('failed', 'try again');
      const output = stderrData.join('');
      expect(output).toContain('failed');
      expect(output).toContain('try again');
    });
  });

  describe('errorJson', () => {
    test('writes JSON error to stderr', () => {
      errorJson('NOT_FOUND', 'resource missing');
      const output = stderrData.join('');
      const parsed = JSON.parse(output.trim());
      expect(parsed.error).toBe('NOT_FOUND');
      expect(parsed.message).toBe('resource missing');
      expect(stdoutData).toHaveLength(0);
    });
  });
});
