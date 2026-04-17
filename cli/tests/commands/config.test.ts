import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';

// Track calls to mocked modules
const configCalls = {
  resolveConfig: [] as unknown[][],
  writeConfig: [] as unknown[][],
};

let resolveConfigResult: unknown = {
  apiUrl: 'https://api.example.com',
  apiKey: 'test-key-1234',
  source: 'env' as const,
};
let resolveConfigThrows = false;

mock.module('../../src/lib/config.js', () => ({
  resolveConfig: () => {
    configCalls.resolveConfig.push([]);
    if (resolveConfigThrows) {
      const { ConfigError } = require('../../src/lib/errors.js');
      throw new ConfigError(
        'No VCS configuration found',
        'Run "vcs config init" or set VCS_API_URL and VCS_API_KEY environment variables'
      );
    }
    return Promise.resolve(resolveConfigResult);
  },
  writeConfig: (...args: unknown[]) => {
    configCalls.writeConfig.push(args);
    return Promise.resolve();
  },
  maskApiKey: (key: string) => {
    if (key.length <= 4) return '****';
    return '****' + key.slice(-4);
  },
  CONFIG_FILE: '/home/test/.vcs/config.json',
  CONFIG_DIR: '/home/test/.vcs',
}));

const outputCalls = {
  result: [] as unknown[][],
  error: [] as unknown[][],
  errorJson: [] as unknown[][],
  status: [] as unknown[][],
  success: [] as unknown[][],
};

mock.module('../../src/lib/output.js', () => ({
  result: (...args: unknown[]) => { outputCalls.result.push(args); },
  error: (...args: unknown[]) => { outputCalls.error.push(args); },
  errorJson: (...args: unknown[]) => { outputCalls.errorJson.push(args); },
  status: (...args: unknown[]) => { outputCalls.status.push(args); },
  success: (...args: unknown[]) => { outputCalls.success.push(args); },
}));

const originalFetch = globalThis.fetch;

import { registerConfig } from '../../src/commands/config.js';
import { Command } from '@commander-js/extra-typings';

describe('config command', () => {
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as never);
    for (const key of Object.keys(outputCalls) as (keyof typeof outputCalls)[]) {
      outputCalls[key] = [];
    }
    configCalls.resolveConfig = [];
    configCalls.writeConfig = [];
    resolveConfigThrows = false;
    resolveConfigResult = {
      apiUrl: 'https://api.example.com',
      apiKey: 'test-key-1234',
      source: 'env' as const,
    };
  });

  afterEach(() => {
    exitSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  describe('config show', () => {
    it('displays resolved config with masked key from env', async () => {
      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(['config', 'show'], { from: 'user' });

      expect(outputCalls.result.length).toBe(1);
      const data = outputCalls.result[0]![0] as Record<string, unknown>;
      expect(data.api_url).toBe('https://api.example.com');
      expect(data.api_key).toBe('****1234');
      expect(data.source).toBe('env');
      expect(data.config_file).toBe('/home/test/.vcs/config.json');
    });

    it('displays resolved config with source file', async () => {
      resolveConfigResult = {
        apiUrl: 'https://file.example.com',
        apiKey: 'file-key-5678',
        source: 'file',
      };

      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(['config', 'show'], { from: 'user' });

      expect(outputCalls.result.length).toBe(1);
      const data = outputCalls.result[0]![0] as Record<string, unknown>;
      expect(data.source).toBe('file');
      expect(data.api_key).toBe('****5678');
    });

    it('outputs JSON with --json flag', async () => {
      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(['--json', 'config', 'show'], { from: 'user' });

      expect(outputCalls.result.length).toBe(1);
      const isJson = outputCalls.result[0]![1];
      expect(isJson).toBe(true);
    });

    it('shows error when no config found', async () => {
      resolveConfigThrows = true;

      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(['config', 'show'], { from: 'user' });

      expect(outputCalls.error.length).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('config init', () => {
    it('writes config with --url and --key flags', async () => {
      globalThis.fetch = (() =>
        Promise.resolve(new Response('{}', { status: 200 }))
      ) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(
        ['config', 'init', '--url', 'https://my-api.com', '--key', 'my-secret-key'],
        { from: 'user' }
      );

      expect(configCalls.writeConfig.length).toBe(1);
      expect(configCalls.writeConfig[0]![0]).toBe('https://my-api.com');
      expect(configCalls.writeConfig[0]![1]).toBe('my-secret-key');
      expect(outputCalls.success.length).toBeGreaterThanOrEqual(1);
    });

    it('validates connectivity before writing', async () => {
      let fetchCalled = false;
      globalThis.fetch = ((_url: string | URL | Request) => {
        fetchCalled = true;
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(
        ['config', 'init', '--url', 'https://my-api.com', '--key', 'my-key'],
        { from: 'user' }
      );

      expect(fetchCalled).toBe(true);
      expect(outputCalls.status.length).toBeGreaterThanOrEqual(1);
    });

    it('still writes config when connectivity validation fails', async () => {
      globalThis.fetch = (() =>
        Promise.resolve(new Response('', { status: 500 }))
      ) as typeof fetch;

      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(
        ['config', 'init', '--url', 'https://my-api.com', '--key', 'my-key'],
        { from: 'user' }
      );

      expect(configCalls.writeConfig.length).toBe(1);
      expect(outputCalls.success.length).toBeGreaterThanOrEqual(1);
    });

    it('errors in non-TTY mode without flags', async () => {
      // process.stdin.isTTY is undefined in test env (non-TTY)
      const program = new Command().option('--json', 'JSON output');
      registerConfig(program);
      await program.parseAsync(['config', 'init'], { from: 'user' });

      expect(outputCalls.error.length).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
