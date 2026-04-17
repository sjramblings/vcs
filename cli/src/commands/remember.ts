import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson, success } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

export function registerRemember(program: Command): void {
  program
    .command('remember')
    .description('Store a memory in Viking Context Service')
    .argument('<text>', 'Text to remember')
    .option('--category <name>', 'Memory category', 'general')
    .action(async (text, options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const prefix = 'viking://user/memories/' + options.category + '/';

        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        const contentBase64 = Buffer.from(text).toString('base64');

        const response = await apiCall('resources', {
          method: 'POST',
          body: {
            content_base64: contentBase64,
            uri_prefix: prefix,
            filename,
          },
          timeout: 60_000,
        });

        if (!response.ok) {
          let msg = `API returned ${response.status}`;
          try {
            const errBody = (await response.json()) as Record<string, unknown>;
            if (errBody.error) msg = String(errBody.error);
          } catch { /* ignore parse errors */ }

          if (isJson) {
            errorJson('REMEMBER_FAILED', msg);
          } else {
            error(msg, 'Check text and category');
          }
          process.exit(exitCodeFromStatus(response.status));
          return;
        }

        const data = (await response.json()) as { status: string; uri: string; processing_status: string };

        if (isJson) {
          result(data, true);
        } else {
          success('Remembered at ' + data.uri);
        }
        process.exit(0);
      } catch (err: unknown) {
        if (err instanceof CliError) {
          if (isJson) {
            errorJson(err.code ?? 'ERROR', err.message);
          } else {
            error(err.message, err.hint);
          }
        } else {
          if (isJson) {
            errorJson('REMEMBER_ERROR', 'Remember request failed');
          } else {
            error('Remember request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
