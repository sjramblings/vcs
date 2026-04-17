import type { Command } from '@commander-js/extra-typings';
import { createInterface } from 'node:readline/promises';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson, success, status } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

export function registerRm(program: Command): void {
  program
    .command('rm')
    .description('Remove a node')
    .argument('<uri>', 'URI to remove')
    .option('--force', 'Skip confirmation prompt')
    .action(async (uri, options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;
      const force = options.force ?? false;

      try {
        // Confirmation logic
        if (!force) {
          if (process.stdin.isTTY) {
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            try {
              const answer = await rl.question('Remove ' + uri + '? [y/N] ');
              if (answer !== 'y' && answer !== 'Y') {
                status('Aborted');
                process.exit(0);
              }
            } finally {
              rl.close();
            }
          } else {
            if (isJson) {
              errorJson('RM_FAILED', 'Confirmation required (use --force in non-interactive mode)');
            } else {
              error('Confirmation required (use --force in non-interactive mode)');
            }
            process.exit(1);
            return;
          }
        }

        // Delete call
        const response = await apiCall('fs/rm?uri=' + encodeURIComponent(uri), {
          method: 'DELETE',
        });

        if (response.ok) {
          const data = (await response.json()) as { status: string; deleted: number };
          if (isJson) {
            result({ uri, deleted: data.deleted }, true);
          } else {
            success('Removed ' + uri);
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
            errorJson('RM_FAILED', 'Not found: ' + uri);
          } else {
            error('Not found: ' + uri);
          }
          process.exit(1);
        }

        if (response.status === 409) {
          if (isJson) {
            errorJson('RM_FAILED', 'Cannot remove while processing');
          } else {
            error('Cannot remove while processing');
          }
          process.exit(1);
        }

        if (isJson) {
          errorJson('RM_FAILED', msg);
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
            errorJson('RM_ERROR', 'rm request failed');
          } else {
            error('rm request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
