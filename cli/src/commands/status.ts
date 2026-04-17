import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson } from '../lib/output.js';
import { resolveConfig } from '../lib/config.js';
import { CliError } from '../lib/errors.js';

const SCOPES = ['resources', 'user', 'agent', 'session'] as const;

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show VCS instance status and namespace summary')
    .action(async (_options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const config = await resolveConfig();

        // Health check with latency — also gives us resources count
        const start = performance.now();
        const response = await apiCall('/fs/ls?uri=viking://resources/', { timeout: 5_000, retries: 0 });
        const latency = Math.round(performance.now() - start);

        if (!response.ok) {
          if (isJson) {
            errorJson('HEALTH_FAILED', 'API returned ' + response.status);
          } else {
            error('API returned ' + response.status, 'Check API URL and key');
          }
          process.exit(2);
        }

        // Parse resources count from health check response
        const resourcesData = (await response.json()) as { items: unknown[] };
        const resourcesCount = resourcesData.items.length;

        // Enumerate remaining 3 scopes in parallel
        const remaining = SCOPES.filter(s => s !== 'resources');
        const otherCounts = await Promise.all(
          remaining.map(async (scope) => {
            try {
              const resp = await apiCall(
                `/fs/ls?uri=${encodeURIComponent(`viking://${scope}/`)}`,
                { timeout: 5_000, retries: 0 }
              );
              if (resp.ok) {
                const data = (await resp.json()) as { items: unknown[] };
                return data.items.length;
              }
              return 0;
            } catch {
              return 0;
            }
          })
        );

        const namespaces: Record<string, number> = { resources: resourcesCount };
        remaining.forEach((s, i) => { namespaces[s] = otherCounts[i]!; });

        if (isJson) {
          result({ endpoint: config.apiUrl, latency_ms: latency, namespaces }, true);
        } else {
          // Custom human-readable output with right-aligned keys
          const maxKeyLen = Math.max('endpoint'.length, 'latency'.length);
          const lines: string[] = [
            `${'endpoint'.padStart(maxKeyLen)}  ${config.apiUrl}`,
            `${'latency'.padStart(maxKeyLen)}  ${latency}ms`,
            '',
            'Namespaces:',
          ];
          const maxScopeLen = Math.max(...SCOPES.map(s => s.length));
          for (const scope of SCOPES) {
            lines.push(`  ${scope.padStart(maxScopeLen)}  ${namespaces[scope]}`);
          }
          process.stdout.write(lines.join('\n') + '\n');
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
            errorJson('UNREACHABLE', 'Cannot reach VCS API');
          } else {
            error('Cannot reach VCS API', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
