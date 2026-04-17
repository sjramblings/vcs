import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson, success, status } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

const VALID_ROLES = ['user', 'assistant', 'system', 'tool'] as const;

export function registerSession(program: Command): void {
  const sessionCmd = program
    .command('session')
    .description('Manage VCS sessions');

  sessionCmd
    .command('create')
    .description('Create a new session')
    .action(async (_options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const response = await apiCall('sessions', { method: 'POST' });

        if (response.ok) {
          const data = (await response.json()) as { session_id: string; status: string };
          if (isJson) {
            result({ session_id: data.session_id, status: data.status }, true);
          } else {
            process.stdout.write(data.session_id + '\n');
          }
          process.exit(0);
        }

        let msg = 'API returned ' + response.status;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (errBody.error) msg = String(errBody.error);
        } catch { /* ignore parse errors */ }

        if (isJson) {
          errorJson('SESSION_CREATE_FAILED', msg);
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
            errorJson('SESSION_ERROR', 'session create request failed');
          } else {
            error('session create request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });

  sessionCmd
    .command('message')
    .description('Add a message to a session')
    .argument('<id>', 'Session ID')
    .argument('<role>', 'Message role (user|assistant|system|tool)')
    .argument('<content>', 'Message text')
    .action(async (id, role, content, _options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
        if (isJson) {
          errorJson('INVALID_ROLE', 'Invalid role. Must be: user, assistant, system, tool');
        } else {
          error('Invalid role. Must be: user, assistant, system, tool');
        }
        process.exit(1);
        return;
      }

      try {
        const response = await apiCall('sessions/' + id + '/messages', {
          method: 'POST',
          body: { role, parts: [{ type: 'text', content }] },
        });

        if (response.ok) {
          const data = (await response.json()) as { sequence: number };
          if (isJson) {
            result({ session_id: id, sequence: data.sequence }, true);
          } else {
            success('Message added (sequence ' + data.sequence + ')');
          }
          process.exit(0);
        }

        let msg = 'API returned ' + response.status;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (errBody.error) msg = String(errBody.error);
        } catch { /* ignore parse errors */ }

        if (response.status === 404) {
          if (isJson) {
            errorJson('SESSION_NOT_FOUND', 'Session not found');
          } else {
            error('Session not found');
          }
          process.exit(1);
          return;
        }

        if (isJson) {
          errorJson('SESSION_MESSAGE_FAILED', msg);
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
            errorJson('SESSION_ERROR', 'session message request failed');
          } else {
            error('session message request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });

  sessionCmd
    .command('used')
    .description('Record context usage')
    .argument('<id>', 'Session ID')
    .argument('<uris...>', 'URIs to record')
    .action(async (id, uris, _options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const response = await apiCall('sessions/' + id + '/used', {
          method: 'POST',
          body: { uris },
        });

        if (response.ok) {
          const data = (await response.json()) as { recorded: number };
          if (isJson) {
            result({ session_id: id, recorded: data.recorded }, true);
          } else {
            success('Recorded ' + data.recorded + ' URI(s)');
          }
          process.exit(0);
        }

        let msg = 'API returned ' + response.status;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (errBody.error) msg = String(errBody.error);
        } catch { /* ignore parse errors */ }

        if (response.status === 404) {
          if (isJson) {
            errorJson('SESSION_NOT_FOUND', 'Session not found');
          } else {
            error('Session not found');
          }
          process.exit(1);
          return;
        }

        if (isJson) {
          errorJson('SESSION_USED_FAILED', msg);
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
            errorJson('SESSION_ERROR', 'session used request failed');
          } else {
            error('session used request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });

  sessionCmd
    .command('commit')
    .description('Commit and archive a session')
    .argument('<id>', 'Session ID')
    .action(async (id, _options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const response = await apiCall('sessions/' + id + '/commit', {
          method: 'POST',
          timeout: 60_000,
        });

        if (response.ok) {
          const data = (await response.json()) as { status: string; session_uri: string; memory_extraction: string };
          if (data.status === 'already_committed') {
            if (isJson) {
              result(data, true);
            } else {
              status('Session already committed');
            }
            process.exit(0);
          }
          if (isJson) {
            result(data, true);
          } else {
            success('Session committed: ' + data.session_uri);
          }
          process.exit(0);
        }

        let msg = 'API returned ' + response.status;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (errBody.error) msg = String(errBody.error);
        } catch { /* ignore parse errors */ }

        if (response.status === 404) {
          if (isJson) {
            errorJson('SESSION_NOT_FOUND', 'Session not found');
          } else {
            error('Session not found');
          }
          process.exit(1);
          return;
        }

        if (isJson) {
          errorJson('SESSION_COMMIT_FAILED', msg);
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
            errorJson('SESSION_ERROR', 'session commit request failed');
          } else {
            error('session commit request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });

  sessionCmd
    .command('delete')
    .description('Delete a session')
    .argument('<id>', 'Session ID')
    .action(async (id, _options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const response = await apiCall('sessions/' + id, { method: 'DELETE' });

        if (response.ok) {
          const data = (await response.json()) as { status: string; deleted: number };
          if (isJson) {
            result({ session_id: id, deleted: data.deleted }, true);
          } else {
            success('Deleted session ' + id + ' (' + data.deleted + ' entries)');
          }
          process.exit(0);
        }

        let msg = 'API returned ' + response.status;
        try {
          const errBody = (await response.json()) as Record<string, unknown>;
          if (errBody.error) msg = String(errBody.error);
        } catch { /* ignore parse errors */ }

        if (response.status === 404) {
          if (isJson) {
            errorJson('SESSION_NOT_FOUND', 'Session not found');
          } else {
            error('Session not found');
          }
          process.exit(1);
          return;
        }

        if (isJson) {
          errorJson('SESSION_DELETE_FAILED', msg);
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
            errorJson('SESSION_ERROR', 'session delete request failed');
          } else {
            error('session delete request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
