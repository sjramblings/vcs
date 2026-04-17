import type { Command } from '@commander-js/extra-typings';
import { resolveConfig, writeConfig, maskApiKey, CONFIG_FILE } from '../lib/config.js';
import { result, success, error, errorJson, status } from '../lib/output.js';
import { CliError, ConfigError } from '../lib/errors.js';
import { createInterface } from 'node:readline/promises';

export function registerConfig(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage VCS configuration');

  configCmd
    .command('init')
    .description('Initialize VCS configuration')
    .option('--url <url>', 'VCS API URL')
    .option('--key <key>', 'VCS API key')
    .action(async (options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      let url = options.url;
      let key = options.key;

      // Handle missing flags
      if (!url && !key) {
        if (process.stdin.isTTY) {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            process.stderr.write('\nConfigure VCS CLI. You need:\n');
            process.stderr.write('  1. API URL — from CDK deploy output (VcsStack.ApiLayerApiEndpoint)\n');
            process.stderr.write('  2. API key — retrieve with: aws apigateway get-api-key --api-key <id> --include-value --query value --output text\n\n');
            url = await rl.question('VCS API URL: ');
            key = await rl.question('VCS API key: ');
          } finally {
            rl.close();
          }
        } else {
          if (isJson) {
            errorJson('MISSING_FLAGS', 'Provide --url and --key flags');
          } else {
            error('Missing required flags', 'Usage: vcs config init --url <url> --key <key>');
          }
          process.exit(1);
          return;
        }
      } else if (!url || !key) {
        if (isJson) {
          errorJson('MISSING_FLAGS', 'Both --url and --key are required');
        } else {
          error('Both --url and --key are required', 'Usage: vcs config init --url <url> --key <key>');
        }
        process.exit(1);
        return;
      }

      // Validate connectivity
      try {
        const baseUrl = url.endsWith('/') ? url : url + '/';
        const probeUrl = new URL('fs/ls?uri=viking://resources/', baseUrl).toString();
        const response = await fetch(probeUrl, {
          headers: { 'x-api-key': key },
          signal: AbortSignal.timeout(5_000),
        });

        if (response.ok) {
          status('Connection verified');
        } else {
          status('Warning: could not verify connection (HTTP ' + response.status + ')');
        }
      } catch {
        status('Warning: could not verify connection');
      }

      // Write config
      try {
        await writeConfig(url, key);
        success('Configuration saved to ' + CONFIG_FILE);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isJson) {
          errorJson('WRITE_FAILED', 'Failed to write config: ' + msg);
        } else {
          error('Failed to write config: ' + msg);
        }
        process.exit(1);
      }
    });

  configCmd
    .command('show')
    .description('Show current VCS configuration')
    .action(async (_options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const config = await resolveConfig();
        const display = {
          api_url: config.apiUrl,
          api_key: maskApiKey(config.apiKey),
          source: config.source,
          config_file: CONFIG_FILE,
        };
        result(display, isJson);
      } catch (err: unknown) {
        if (err instanceof ConfigError) {
          if (isJson) {
            errorJson(err.code ?? 'CONFIG_ERROR', err.message);
          } else {
            error(err.message, err.hint);
          }
          process.exit(1);
        } else {
          throw err;
        }
      }
    });
}
