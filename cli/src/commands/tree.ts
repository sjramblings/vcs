import type { Command } from '@commander-js/extra-typings';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

interface TreeNode {
  uri: string;
  is_directory: boolean;
  context_type?: string;
  children?: TreeNode[];
}

interface TreeResponse {
  root: TreeNode;
}

function renderTree(node: TreeNode, prefix = '', isLast = true, isRoot = true): string {
  const lines: string[] = [];
  const label = isRoot
    ? node.uri
    : node.uri.replace(/\/$/, '').split('/').pop() ?? node.uri;

  if (isRoot) {
    lines.push(label);
  } else {
    lines.push(`${prefix}${isLast ? '\u2514\u2500\u2500 ' : '\u251c\u2500\u2500 '}${label}`);
  }

  const children = node.children ?? [];
  children.forEach((child, i) => {
    const childIsLast = i === children.length - 1;
    const childPrefix = isRoot ? '' : `${prefix}${isLast ? '    ' : '\u2502   '}`;
    lines.push(renderTree(child, childPrefix, childIsLast, false));
  });

  return lines.join('\n');
}

export function registerTree(program: Command): void {
  program
    .command('tree')
    .description('Show recursive namespace tree')
    .argument('<uri>', 'Root URI to display tree from')
    .option('--depth <n>', 'Maximum depth to traverse (min 1)', '3')
    .action(async (rawUri, options, cmd) => {
      const uri = rawUri.endsWith('/') ? rawUri : rawUri + '/';
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        const path = `/fs/tree?uri=${encodeURIComponent(uri)}&depth=${options.depth}`;
        const response = await apiCall(path);

        if (!response.ok) {
          let msg = `API returned ${response.status}`;
          try {
            const errBody = await response.json() as Record<string, unknown>;
            if (errBody.error) msg = String(errBody.error);
          } catch { /* ignore parse errors */ }

          if (isJson) {
            errorJson('TREE_FAILED', msg);
          } else {
            error(msg, 'Check URI and depth');
          }
          process.exit(exitCodeFromStatus(response.status));
          return;
        }

        const data = (await response.json()) as TreeResponse;

        if (isJson) {
          result(data, true);
        } else {
          process.stdout.write(renderTree(data.root) + '\n');
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
            errorJson('TREE_ERROR', 'Tree request failed');
          } else {
            error('Tree request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
