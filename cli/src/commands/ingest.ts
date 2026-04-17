import type { Command } from '@commander-js/extra-typings';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { apiCall } from '../lib/client.js';
import { result, error, errorJson, status, success } from '../lib/output.js';
import { CliError, exitCodeFromStatus } from '../lib/errors.js';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.xml', '.html']);

export function normaliseFilename(raw: string): string {
  let name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '');

  // Ensure starts with [a-z0-9]
  while (name.length > 0 && !/^[a-z0-9]/.test(name)) {
    name = name.slice(1);
  }

  return name || 'unnamed';
}

function ensureTrailingSlash(uri: string): string {
  return uri.endsWith('/') ? uri : uri + '/';
}

async function ingestContent(
  contentBase64: string,
  prefix: string,
  filename: string,
  isJson: boolean,
): Promise<{ ok: boolean; uri?: string; error?: string }> {
  try {
    const response = await apiCall('resources', {
      method: 'POST',
      body: {
        content_base64: contentBase64,
        uri_prefix: ensureTrailingSlash(prefix),
        filename,
      },
      timeout: 60_000,
    });

    if (!response.ok) {
      let msg = `API returned ${response.status}`;
      try {
        const errBody = (await response.json()) as Record<string, unknown>;
        if (errBody.error) msg = String(errBody.error);
      } catch {
        /* ignore parse errors */
      }
      return { ok: false, error: msg };
    }

    const data = (await response.json()) as { status: string; uri: string; processing_status: string };
    return { ok: true, uri: data.uri };
  } catch (err: unknown) {
    if (err instanceof CliError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: 'Request failed' };
  }
}

async function collectFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { recursive: true });
  const files: string[] = [];

  for (const entry of entries) {
    // Skip if any path segment starts with .
    const segments = entry.split(path.sep);
    if (segments.some((s) => s.startsWith('.'))) continue;

    // Skip if extension not in TEXT_EXTENSIONS
    const ext = path.extname(entry).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) continue;

    const fullPath = path.join(dirPath, entry);
    const fileStat = await stat(fullPath);
    if (fileStat.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

export function registerIngest(program: Command): void {
  program
    .command('ingest')
    .description('Ingest files into Viking Context Service')
    .argument('<path>', 'File path, directory path, or - for stdin')
    .option('--prefix <uri>', 'URI prefix for ingested content', 'viking://resources/')
    .option('--filename <name>', 'Override filename (required for stdin)')
    .option('--recursive', 'Ingest directory recursively')
    .action(async (pathArg, options, cmd) => {
      const isJson = cmd.optsWithGlobals<{ json?: boolean }>().json ?? false;

      try {
        // Branch 1: stdin
        if (pathArg === '-') {
          if (!options.filename) {
            if (isJson) {
              errorJson('INGEST_FAILED', '--filename is required when reading from stdin');
            } else {
              error('--filename is required when reading from stdin');
            }
            process.exit(1);
            return;
          }

          const chunks: Uint8Array[] = [];
          for await (const chunk of Bun.stdin.stream()) {
            chunks.push(chunk);
          }
          const content = Buffer.concat(chunks).toString('utf-8');
          const contentBase64 = Buffer.from(content).toString('base64');
          const filename = normaliseFilename(options.filename);

          const res = await ingestContent(contentBase64, options.prefix, filename, isJson);
          if (res.ok) {
            if (isJson) {
              result({ uri: res.uri }, true);
            } else {
              success('Ingested ' + res.uri);
            }
            process.exit(0);
          } else {
            if (isJson) {
              errorJson('INGEST_FAILED', res.error!);
            } else {
              error(res.error!);
            }
            process.exit(1);
          }
          return;
        }

        // Resolve path
        const resolvedPath = path.resolve(pathArg);
        let pathStat;
        try {
          pathStat = await stat(resolvedPath);
        } catch {
          if (isJson) {
            errorJson('INGEST_FAILED', 'File not found: ' + pathArg);
          } else {
            error('File not found: ' + pathArg);
          }
          process.exit(1);
          return;
        }

        // Branch 2: directory
        if (pathStat.isDirectory()) {
          if (!options.recursive) {
            if (isJson) {
              errorJson('INGEST_FAILED', 'Use --recursive to ingest a directory');
            } else {
              error('Use --recursive to ingest a directory');
            }
            process.exit(1);
            return;
          }

          const files = await collectFiles(resolvedPath);
          if (files.length === 0) {
            if (isJson) {
              errorJson('INGEST_FAILED', 'No eligible files found');
            } else {
              error('No eligible files found');
            }
            process.exit(1);
            return;
          }

          let ingested = 0;
          let skipped = 0;
          const errors: string[] = [];

          for (const file of files) {
            const relPath = path.relative(resolvedPath, file);
            const subDir = path.dirname(relPath);
            const filename = normaliseFilename(path.basename(file));
            const filePrefix =
              subDir === '.'
                ? ensureTrailingSlash(options.prefix)
                : ensureTrailingSlash(options.prefix + subDir.split(path.sep).join('/') + '/');

            const fileContent = await Bun.file(file).text();
            const contentBase64 = Buffer.from(fileContent).toString('base64');

            const res = await ingestContent(contentBase64, filePrefix, filename, isJson);
            if (res.ok) {
              success(path.basename(file));
              ingested++;
            } else {
              error(path.basename(file) + ' (failed: ' + res.error + ')');
              errors.push(relPath + ': ' + res.error);
              skipped++;
            }
          }

          status('Ingested ' + ingested + ' files (' + skipped + ' failed)');

          if (isJson) {
            result({ ingested, failed: skipped, errors }, true);
          }

          process.exit(skipped > 0 ? 1 : 0);
          return;
        }

        // Branch 3: single file
        let fileContent: string;
        try {
          fileContent = await Bun.file(resolvedPath).text();
        } catch {
          if (isJson) {
            errorJson('INGEST_FAILED', 'File not found: ' + pathArg);
          } else {
            error('File not found: ' + pathArg);
          }
          process.exit(1);
          return;
        }

        const filename = options.filename
          ? normaliseFilename(options.filename)
          : normaliseFilename(path.basename(resolvedPath));
        const contentBase64 = Buffer.from(fileContent).toString('base64');

        const res = await ingestContent(contentBase64, options.prefix, filename, isJson);
        if (res.ok) {
          if (isJson) {
            result({ uri: res.uri }, true);
          } else {
            success('Ingested ' + res.uri);
          }
          process.exit(0);
        } else {
          if (isJson) {
            errorJson('INGEST_FAILED', res.error!);
          } else {
            error(res.error!);
          }
          process.exit(1);
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
            errorJson('INGEST_ERROR', 'Ingest request failed');
          } else {
            error('Ingest request failed', 'Check VCS_API_URL or run "vcs config show"');
          }
        }
        process.exit(2);
      }
    });
}
