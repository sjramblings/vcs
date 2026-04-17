import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson, success } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

export function registerMv(program: Command): void {
  program
    .command('mv')
    .description('Move or rename a node')
    .argument('<from>', 'Source URI')
    .argument('<to>', 'Destination URI')
    .action(async (from, to, _options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const response = await apiCall('fs/mv', {
          method: 'POST',
          body: { from_uri: from, to_uri: to },
        });

        if (response.ok) {
          const data = (await response.json()) as { status: string; moved: number };
          if (isJson) {
            result({ from, to, moved: data.moved }, true);
          } else {
            success('Moved ' + from + ' \u2192 ' + to);
          }
          process.exit(0);
        }

        // Parse error body
        let msg = 'API returned ' + response.status;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (errBody.error) msg = String(errBody.error);
        } catch {
          /* ignore parse errors */
        }

        if (response.status === 404) {
          if (isJson) {
            errorJson('MV_FAILED', 'Source not found: ' + from);
          } else {
            error('Source not found: ' + from);
          }
          process.exit(1);
        }

        if (response.status === 409) {
          if (isJson) {
            errorJson('MV_FAILED', 'Cannot move while processing');
          } else {
            error('Cannot move while processing');
          }
          process.exit(1);
        }

        if (isJson) {
          errorJson('MV_FAILED', msg);
        } else {
          error(msg);
        }
        process.exit(exitCodeFromStatus(response.status));
      } catch (err: unknown) {
        if (err instanceof CliError) {
          if (isJson) {
            errorJson(err.code ?? 'ERROR', err.message);
          } else {
            error(err.message, err.hint);
          }
        } else {
          if (isJson) {
            errorJson('MV_ERROR', 'mv request failed');
          } else {
            error('mv request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
