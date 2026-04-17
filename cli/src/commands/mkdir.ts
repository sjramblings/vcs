import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson, success } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

export function registerMkdir(program: Command): void {
  program
    .command('mkdir')
    .description('Create a directory node')
    .argument('<uri>', 'Directory URI to create')
    .action(async (uri, _options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      // Directory URIs must end with /
      const dirUri = uri.endsWith('/') ? uri : uri + '/';

      try {
        const response = await apiCall('fs/mkdir', {
          method: 'POST',
          body: { uri: dirUri },
        });

        if (response.ok) {
          if (isJson) {
            result({ uri: dirUri, created: true }, true);
          } else {
            success('Created ' + dirUri);
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

        if (response.status === 409) {
          if (isJson) {
            errorJson('MKDIR_FAILED', 'Directory already exists');
          } else {
            error('Directory already exists: ' + dirUri);
          }
          process.exit(1);
        }

        if (isJson) {
          errorJson('MKDIR_FAILED', msg);
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
            errorJson('MKDIR_ERROR', 'mkdir request failed');
          } else {
            error('mkdir request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
