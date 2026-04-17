import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

interface LsItem {
  uri: string;
  is_directory: boolean;
  context_type: string;
  created_at: string;
  updated_at: string;
}

interface LsResponse {
  items: LsItem[];
  nextToken?: string;
}

export function registerLs(program: Command): void {
  program
    .command('ls')
    .description('List children of a directory URI')
    .argument('<uri>', 'Directory URI to list')
    .action(async (rawUri, _options, cmd) => {
      const uri = rawUri.endsWith('/') ? rawUri : rawUri + '/';
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const allItems: LsItem[] = [];
        let nextToken: string | undefined;

        do {
          let path = `/fs/ls?uri=${encodeURIComponent(uri)}`;
          if (nextToken) path += `&nextToken=${encodeURIComponent(nextToken)}`;

          const response = await apiCall(path);

          if (!response.ok) {
            let msg = `API returned ${response.status}`;
            try {
              const errBody = await response.json() as Record<string, unknown>;
              if (errBody.error) msg = String(errBody.error);
            } catch { /* ignore parse errors */ }

            if (isJson) {
              errorJson('LS_FAILED', msg);
            } else {
              error(msg, 'Check URI');
            }
            process.exit(exitCodeFromStatus(response.status));
            return;
          }

          const data = (await response.json()) as LsResponse;
          allItems.push(...data.items);
          nextToken = data.nextToken;
        } while (nextToken);

        if (allItems.length === 0) {
          process.stderr.write('No items found.\n');
          process.exit(0);
          return;
        }

        if (isJson) {
          result(allItems, true);
        } else {
          result(allItems, false);
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
            errorJson('LS_ERROR', 'List request failed');
          } else {
            error('List request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
