import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

interface ReadResponse {
  uri: string;
  level: number;
  content: string;
  tokens?: number;
}

export function registerRead(program: Command): void {
  program
    .command('read')
    .description('Read content at specified detail level')
    .argument('<uri>', 'Resource URI to read')
    .option('--level <n>', 'Detail level: 0 (summary), 1 (outline), 2 (full)', '2')
    .action(async (uri, options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const path = `/fs/read?uri=${encodeURIComponent(uri)}&level=${options.level}`;
        const response = await apiCall(path);

        if (!response.ok) {
          let msg = `API returned ${response.status}`;
          try {
            const errBody = await response.json() as Record<string, unknown>;
            if (errBody.error) msg = String(errBody.error);
          } catch { /* ignore parse errors */ }

          if (isJson) {
            errorJson('READ_FAILED', msg);
          } else {
            error(msg, 'Check URI and options');
          }
          process.exit(exitCodeFromStatus(response.status));
          return;
        }

        const data = (await response.json()) as ReadResponse;

        if (isJson) {
          result(data, true);
        } else {
          process.stdout.write(data.content);
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
            errorJson('READ_ERROR', 'Read request failed');
          } else {
            error('Read request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
