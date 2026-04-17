import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

interface SearchResult {
  uri: string;
  score: number;
  level: number;
  abstract: string;
}

interface FindResponse {
  results: SearchResult[];
  trajectory: unknown[];
  tokens_saved_estimate: number;
}

function formatFindResults(results: SearchResult[]): string {
  return results
    .map(r => `${r.score.toFixed(2)}  ${r.uri}\n      ${r.abstract}`)
    .join('\n\n');
}

export function registerFind(program: Command): void {
  program
    .command('find')
    .description('Stateless semantic search')
    .argument('<query>', 'Search query')
    .option('--scope <uri>', 'Limit search to URI scope')
    .option('--max-results <n>', 'Maximum results (1-20)', '5')
    .option('--min-score <n>', 'Minimum score threshold (0-1)', '0.2')
    .action(async (query, options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const response = await apiCall('/search/find', {
          method: 'POST',
          body: {
            query,
            scope: options.scope,
            max_results: Number(options.maxResults),
            min_score: Number(options.minScore),
          },
        });

        if (!response.ok) {
          let msg = `API returned ${response.status}`;
          try {
            const errBody = await response.json() as Record<string, unknown>;
            if (errBody.error) msg = String(errBody.error);
          } catch { /* ignore parse errors */ }

          if (isJson) {
            errorJson('FIND_FAILED', msg);
          } else {
            error(msg, 'Check query and options');
          }
          process.exit(exitCodeFromStatus(response.status));
          return;
        }

        const data = (await response.json()) as FindResponse;

        if (isJson) {
          result(data, true);
        } else if (data.results.length === 0) {
          process.stderr.write('No results found.\n');
        } else {
          process.stdout.write(formatFindResults(data.results) + '\n');
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
            errorJson('FIND_ERROR', 'Search request failed');
          } else {
            error('Search request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
