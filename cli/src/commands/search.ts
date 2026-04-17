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

interface SearchResponse {
  memories: SearchResult[];
  resources: SearchResult[];
  skills: SearchResult[];
  query_plan: unknown[];
  trajectory: unknown[];
  reason: string | null;
  tokens_saved_estimate: number;
}

function formatScoredBlock(results: SearchResult[]): string {
  return results
    .map(r => `${r.score.toFixed(2)}  ${r.uri}\n      ${r.abstract}`)
    .join('\n\n');
}

function formatSearchResults(data: SearchResponse): void {
  const categories: [string, SearchResult[]][] = [
    ['Resources', data.resources],
    ['Memories', data.memories],
    ['Skills', data.skills],
  ];

  const nonEmpty = categories.filter(([, items]) => items.length > 0);

  if (nonEmpty.length === 0) {
    process.stderr.write('No results found.\n');
    return;
  }

  const output = nonEmpty
    .map(([name, items]) => `\n${name}:\n${formatScoredBlock(items)}`)
    .join('\n');

  process.stdout.write(output + '\n');
}

export function registerSearch(program: Command): void {
  program
    .command('search')
    .description('Session-aware semantic search')
    .argument('<query>', 'Search query')
    .requiredOption('--session <id>', 'Session ID for context-aware search')
    .action(async (query, options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const response = await apiCall('/search/search', {
          method: 'POST',
          body: {
            query,
            session_id: options.session,
          },
        });

        if (!response.ok) {
          let msg = `API returned ${response.status}`;
          try {
            const errBody = await response.json() as Record<string, unknown>;
            if (errBody.error) msg = String(errBody.error);
          } catch { /* ignore parse errors */ }

          if (isJson) {
            errorJson('SEARCH_FAILED', msg);
          } else {
            error(msg, 'Check query and session ID');
          }
          process.exit(exitCodeFromStatus(response.status));
          return;
        }

        const data = (await response.json()) as SearchResponse;

        if (isJson) {
          result(data, true);
        } else {
          formatSearchResults(data);
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
            errorJson('SEARCH_ERROR', 'Search request failed');
          } else {
            error('Search request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
