import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson } from '../lib/output.js';
import { resolveConfig } from '../lib/config.js';
import { CliError } from '../lib/errors.js';

export function registerHealth(program: Command): void {
  program
    .command('health')
    .description('Check VCS API connectivity')
    .action(async (_options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const config = await resolveConfig();
        const start = performance.now();
        const response = await apiCall('/fs/ls?uri=viking://resources/', { timeout: 5_000, retries: 0 });
        const latency = Math.round(performance.now() - start);

        if (response.ok) {
          result({ status: 'ok', latency_ms: latency, endpoint: config.apiUrl }, isJson);
          process.exit(0);
        } else {
          if (isJson) {
            errorJson('HEALTH_FAILED', 'API returned ' + response.status);
          } else {
            error('API returned ' + response.status, 'Check API URL and key');
          }
          process.exit(2);
        }
      } catch (err: unknown) {
        if (err instanceof CliError) {
          if (isJson) {
            errorJson(err.code ?? 'ERROR', err.message);
          } else {
            error(err.message, err.hint);
          }
        } else {
          if (isJson) {
            errorJson('UNREACHABLE', 'Cannot reach VCS API');
          } else {
            error('Cannot reach VCS API', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
